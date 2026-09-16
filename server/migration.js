import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { normalizeAdditionalTypes } from '../shared/constituentTypes.js';
import { MIGRATION_COLLECTIONS, MIGRATION_FIELDS, MIGRATION_REQUIRED, MIGRATION_LIMITS } from '../shared/migrationContract.js';

// Phase one accepts explicitly normalized CSV data, not arbitrary source schemas.
const supported = MIGRATION_COLLECTIONS;
const fields = MIGRATION_FIELDS;
const required = MIGRATION_REQUIRED;
const safeKey = z.string().min(1).max(100).refine(v => !['__proto__', 'prototype', 'constructor'].includes(v), 'Unsupported column name');
const fileSchema = z.object({
  collection: z.enum(supported),
  mapping: z.record(safeKey, safeKey),
  rows: z.array(z.record(safeKey, z.string().max(8000))).min(1).max(MIGRATION_LIMITS.rowsPerBatch),
}).strict().superRefine((file, ctx) => {
  for (const key of Object.keys(file.mapping)) if (!fields[file.collection].includes(key)) ctx.addIssue({ code: 'custom', message: 'Unsupported mapped field: ' + key });
  for (const key of required[file.collection]) if (!Object.hasOwn(file.mapping, key)) ctx.addIssue({ code: 'custom', message: 'Required mapping: ' + key });
  if (file.collection === 'gifts' && Number(Object.hasOwn(file.mapping, 'allocations')) + Number(Object.hasOwn(file.mapping, 'designationSourceId')) !== 1) ctx.addIssue({ code: 'custom', message: 'Map designationSourceId or allocations, exactly one' });
  if (new Set(Object.values(file.mapping)).size !== Object.keys(file.mapping).length) ctx.addIssue({ code: 'custom', message: 'A column cannot map to more than one field' });
  for (const row of file.rows) if (Object.keys(row).length > MIGRATION_LIMITS.columnsPerRow) ctx.addIssue({ code: 'custom', message: 'Maximum ' + MIGRATION_LIMITS.columnsPerRow + ' columns per row' });
});
const requestShape = {
  source: z.string().trim().min(1).max(MIGRATION_LIMITS.sourceName).regex(/^[A-Za-z0-9][A-Za-z0-9 ._-]*$/),
  fileKey: z.string().trim().min(1).max(MIGRATION_LIMITS.fileKey),
  files: z.array(fileSchema).min(1).max(MIGRATION_LIMITS.filesPerBatch),
};
const previewSchema = z.object(requestShape).strict().refine(v => v.files.reduce((n, f) => n + f.rows.length, 0) <= MIGRATION_LIMITS.rowsPerBatch, 'Maximum ' + MIGRATION_LIMITS.rowsPerBatch + ' rows across all files');
const commitSchema = z.object({ ...requestShape, previewDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict().refine(v => v.files.reduce((n, f) => n + f.rows.length, 0) <= MIGRATION_LIMITS.rowsPerBatch, 'Maximum ' + MIGRATION_LIMITS.rowsPerBatch + ' rows across all files');
const text = z.string().max(8000);
const short = z.string().max(300);
const sourceId = z.string().trim().min(1).max(100);
const name = z.string().trim().min(1).max(250);
const email = z.union([z.literal(''), z.email().max(254)]);
// Native contact names are trimmed on save. Reject rather than silently alter
// prepared source names; roles, emails and array order remain literal.
const sourceContacts = z.array(z.object({ name: z.string().min(1).max(250).refine(v => v.trim().length > 0 && v === v.trim(), 'Contact name must be nonblank without surrounding whitespace'), email, role: short }).strict()).max(50);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => Number.isFinite(Date.parse(v)) && new Date(v + 'T00:00:00Z').toISOString().slice(0, 10) === v, 'Invalid source calendar date');
const sourceSchemas = {
  constituents: z.object({ sourceId, name, email, phone: short, type: z.enum(['Individual', 'Business', 'Foundation', 'Alumni', 'Employee', 'Staff', 'Community partner']), household: short, parentSourceId: z.string().max(100), contacts: text.optional(), additionalTypes: text.optional(), segments: short, preference: z.enum(['Email', 'Phone', 'Post', 'Do not contact']), notes: text }).strict(),
  communications: z.object({ sourceId, constituentSourceId: sourceId, subject: name, channel: z.enum(['Email', 'Phone', 'Meeting', 'Post']), status: z.literal('Logged'), accessScope: z.literal('Workspace'), date, body: text, notes: text }).strict(),
  campaigns: z.object({ sourceId, name, type: z.enum(['Annual', 'Capital', 'Major gifts', 'Planned giving', 'Matching gifts', 'Peer-to-peer']), goal: z.string(), startDate: date, endDate: date, status: z.enum(['Active', 'Planned', 'Completed']), description: text }).strict(),
  designations: z.object({ sourceId, name, school: short, parentSourceId: z.string().max(100), accountCode: short.min(1), description: text }).strict(),
  gifts: z.object({ sourceId, donorSourceId: sourceId, campaignSourceId: z.string().max(100).optional(), designationSourceId: z.string().max(100), allocations: text, amount: z.string(), type: z.enum(['Cash', 'In-kind', 'Grant', 'Fee payment', 'Employee giving', 'Sponsorship']), method: z.enum(['Check', 'Cash', 'Credit card', 'ACH', 'Payroll', 'In-kind']), date, externalRef: short, notes: text, tribute: short, softCreditSourceId: z.string().max(100), giftKind: z.enum(['One-time', 'Recurring', 'Pledge fulfillment', 'Matching gift', 'Planned gift']) }).strict(),
};
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value;
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const failure = (status, message) => Object.assign(new Error(message), { status });
const keyOf = (collection, id) => JSON.stringify([collection, id]);
function parseRequest(schema, body) {
  // Inspect raw own keys before Zod can normalize special object properties.
  const pending = [body];
  let visited = 0;
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== 'object') continue;
    if (++visited > 20000) throw failure(400, 'Migration payload structure is too large');
    for (const key of Object.keys(value)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) throw failure(400, 'Unsupported object or column name');
      if (value[key] && typeof value[key] === 'object') pending.push(value[key]);
    }
  }
  return schema.parse(body);
}
function dollarCents(value, allowZero = false) {
  if (!/^\d{1,11}(?:\.\d{1,2})?$/.test(value)) throw failure(400, 'Amount must be an exact nonnegative decimal dollar string with at most two decimal places');
  const [whole, fraction = ''] = value.split('.');
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (cents < (allowZero ? 0n : 1n) || cents > 1000000000000n) throw failure(400, allowZero ? 'Goal must be between zero and the supported campaign maximum' : 'Amount must be between one cent and the supported gift maximum');
  return Number(cents);
}
function normalize(file, row) {
  const raw = Object.fromEntries(fields[file.collection].map(field => [field, Object.hasOwn(file.mapping, field) ? row[file.mapping[field]] : '']));
  for (const [field, column] of Object.entries(file.mapping)) if (!Object.hasOwn(row, column)) throw failure(400, 'Missing mapped column: ' + field);
  if (file.collection === 'constituents' && !raw.preference) raw.preference = 'Email';
  if (file.collection === 'gifts' && !raw.giftKind) raw.giftKind = 'One-time';
  // Preserve source fingerprints from the prior three-collection contract.
  // An unmapped optional campaign link must not become a new empty source field.
  if (file.collection === 'gifts' && !Object.hasOwn(file.mapping, 'campaignSourceId')) delete raw.campaignSourceId;
  if (file.collection === 'constituents') for (const optional of ['contacts','additionalTypes']) if (!Object.hasOwn(file.mapping, optional)) delete raw[optional];
  for (const field of ['sourceId', 'parentSourceId', 'donorSourceId', 'designationSourceId', 'softCreditSourceId', 'campaignSourceId', 'constituentSourceId']) if (Object.hasOwn(raw, field)) raw[field] = raw[field].trim();
  const parsed = sourceSchemas[file.collection].parse(raw);
  if (file.collection === 'constituents' && Object.hasOwn(parsed, 'contacts')) {
    try { parsed.sourceContacts = sourceContacts.parse(JSON.parse(parsed.contacts)); }
    catch { throw failure(400, 'Contacts must be an explicit JSON array of at most 50 rows containing nonblank name, email and role only'); }
  }
  if (file.collection === 'constituents' && Object.hasOwn(parsed, 'additionalTypes')) {
    try { parsed.sourceAdditionalTypes = normalizeAdditionalTypes(parsed.type, JSON.parse(parsed.additionalTypes)); }
    catch { throw failure(400, 'Additional types must be an explicit JSON array of unique known categories from the same person or organization family, excluding the primary type'); }
  }
  if (file.collection === 'communications' && parsed.date > new Date().toISOString().slice(0, 10)) throw failure(400, 'Historical interaction date must be current or past; future drafts are not converted');
  if (file.collection === 'campaigns') {
    parsed.goalCents = dollarCents(parsed.goal, true);
    if (parsed.endDate < parsed.startDate) throw failure(400, 'Source campaign endDate must be on or after startDate');
  }
  if (file.collection === 'gifts') {
    parsed.amountCents = dollarCents(parsed.amount);
    if ((parsed.type === 'In-kind') !== (parsed.method === 'In-kind')) throw failure(400, 'In-kind type and method must agree');
    let allocations;
    if (Object.hasOwn(file.mapping, 'allocations')) {
      try { allocations = z.array(z.object({ designationSourceId: sourceId, amount: z.string() }).strict()).min(1).max(100).parse(JSON.parse(parsed.allocations)); }
      catch { throw failure(400, 'Allocations must be JSON rows containing designationSourceId and exact decimal amount'); }
    } else allocations = [{ designationSourceId: sourceId.parse(parsed.designationSourceId), amount: parsed.amount }];
    parsed.sourceAllocations = allocations.map(a => ({ designationSourceId: a.designationSourceId, amount: dollarCents(a.amount) }));
    if (new Set(parsed.sourceAllocations.map(a => a.designationSourceId)).size !== allocations.length) throw failure(400, 'Duplicate designation allocation');
    if (parsed.sourceAllocations.reduce((n, a) => n + a.amount, 0) !== parsed.amountCents) throw failure(400, 'Source allocations must sum exactly to gift amount');
  }
  return parsed;
}

// Financial controls use integer cents throughout. A matching grand total alone
// cannot detect a gift posted to the wrong revenue class or allocation account.
function controlTotals(gifts) {
  const type = new Map(), method = new Map(), designation = new Map();
  const addGift = (map, key, amount) => {
    const group = map.get(key) || { key, giftCount: 0, cents: 0n };
    group.giftCount++; group.cents += BigInt(amount); map.set(key, group);
  };
  for (const gift of gifts) {
    addGift(type, gift.type, gift.amount);
    addGift(method, gift.method, gift.amount);
    for (const allocation of gift.allocations) {
      const key = JSON.stringify([allocation.sourceId, allocation.accountCode]);
      const group = designation.get(key) || { sourceId: allocation.sourceId, accountCode: allocation.accountCode, allocationCount: 0, cents: 0n };
      group.allocationCount++; group.cents += BigInt(allocation.amount); designation.set(key, group);
    }
  }
  const output = map => [...map.values()].map(({ cents, ...group }) => ({ ...group, totalCents: cents.toString() }));
  return {
    byType: output(type).sort((a, b) => a.key.localeCompare(b.key)),
    byMethod: output(method).sort((a, b) => a.key.localeCompare(b.key)),
    byDesignation: output(designation).sort((a, b) => a.sourceId.localeCompare(b.sourceId) || a.accountCode.localeCompare(b.accountCode)),
  };
}

export function installMigrationRoutes(app, { list, get, create, validate, audit, csrf, admin, transaction, db, collections, schoolYear }) {
  if (!supported.every(c => collections.includes(c))) throw new Error('Migration requires ' + supported.join(', '));
  db.exec(`CREATE TABLE IF NOT EXISTS migration_mapping (
    source TEXT NOT NULL, collection TEXT NOT NULL, external_id TEXT NOT NULL,
    record_id TEXT NOT NULL, source_hash TEXT NOT NULL, record_hash TEXT NOT NULL,
    batch_id TEXT NOT NULL, PRIMARY KEY(source,collection,external_id));
    CREATE TABLE IF NOT EXISTS import_batches (
    id TEXT PRIMARY KEY, source TEXT NOT NULL, file_key TEXT NOT NULL,
    content_hash TEXT NOT NULL, preview_digest TEXT NOT NULL, committed_at TEXT NOT NULL,
    actor TEXT NOT NULL, result TEXT NOT NULL, UNIQUE(source,file_key));
    CREATE INDEX IF NOT EXISTS import_batches_history ON import_batches(committed_at DESC,id DESC);`);
  app.delete('/api/records/:collection/:id', csrf, (req,res,next)=>{
    if(db.prepare('SELECT 1 FROM migration_mapping WHERE collection=? AND record_id=?').get(req.params.collection,req.params.id))return res.status(409).json({error:'Migrated source mappings and record history are retained; reconcile through a supported correction instead of deleting this record'});
    next();
  });
  const signingKey = randomBytes(32);
  const scope = 'Normalized constituent, designation, campaign, Logged historical interaction and posted gift conversion only; contracts, attachments, source voids, original interaction actors/timestamps, provider delivery, recurring execution and full NonProfitEasy history are not converted.';
  const priorBatch = input => db.prepare('SELECT * FROM import_batches WHERE source=? AND file_key=?').get(input.source, input.fileKey);
  const fingerprint = input => hash(input);
  const dependencyHash = currentRecords => hash({
    // Including current data as well as versions detects source-reference/duplicate changes.
    records: supported.map(c => [c, [...currentRecords.get(c)].sort((a, b) => a.id.localeCompare(b.id))]),
    mappings: db.prepare('SELECT * FROM migration_mapping ORDER BY source,collection,external_id').all(),
    // Every fiscal start month must produce a distinct policy fingerprint,
    // including an empty workspace where no gift versions can invalidate it.
    calendar: Array.from({ length: 12 }, (_, i) => schoolYear('2000-' + String(i + 1).padStart(2, '0') + '-01')),
  });
  const digest = (contentHash, dependencies) => createHmac('sha256', signingKey).update(contentHash + ':' + dependencies).digest('hex');
  function plan(input) {
    const contentHash = fingerprint(input);
    const previous = priorBatch(input);
    if (previous) {
      if (previous.content_hash !== contentHash) throw failure(409, 'This source/fileKey was already committed with different content or mapping; use a new fileKey and reconcile source conflicts');
      return { ...JSON.parse(previous.result), valid: true, replayed: true, previewDigest: previous.preview_digest, contentHash, nodes: [] };
    }
    const currentRecords = new Map(supported.map(collection => [collection, list(collection)]));
    const mappings = new Map(db.prepare('SELECT * FROM migration_mapping WHERE source=?').all(input.source).map(m => [keyOf(m.collection, m.external_id), m]));
    const rows = [];
    const nodes = [];
    input.files.forEach((file, fileIndex) => file.rows.forEach((row, rowIndex) => {
      const entry = { file: fileIndex + 1, row: rowIndex + 1, collection: file.collection, sourceId: '', status: 'Valid', error: '' };
      rows.push(entry);
      try {
        const data = normalize(file, row); entry.sourceId = data.sourceId;
        const node = { collection: file.collection, data, entry, sourceHash: hash(data), key: keyOf(file.collection, data.sourceId) };
        nodes.push(node);
      } catch (error) { entry.status = 'Error'; entry.error = error instanceof z.ZodError ? 'Invalid source fields: ' + [...new Set(error.issues.map(i => i.path[0] || 'row'))].join(', ') : error.message; }
    }));
    const index = new Map();
    const reject = (node, message) => { node.entry.status = 'Error'; node.entry.error = message; };
    for (const node of nodes) {
      if (index.has(node.key)) { reject(node, 'Duplicate source identifier in this batch'); reject(index.get(node.key), 'Duplicate source identifier in this batch'); }
      else index.set(node.key, node);
      const prior = mappings.get(node.key);
      if (prior) {
        let current; try { current = get(node.collection, prior.record_id); } catch { reject(node, 'Previously mapped record is missing; reconcile before import'); continue; }
        if (prior.source_hash !== node.sourceHash) reject(node, 'Source identifier was already imported with different values; updates/merges are not supported');
        else if (prior.record_hash !== hash(current)) reject(node, 'Previously imported record changed; reconcile before reuse');
        else { node.existingId = prior.record_id; if (node.entry.status !== 'Error') node.entry.status = 'Already mapped'; }
      }
    }
    const duplicateFields = { constituents: 'email', designations: 'accountCode', gifts: 'externalRef' };
    const normalizedKey = value => String(value || '').trim().toLowerCase();
    const duplicateCollections = supported.filter(collection => Object.hasOwn(duplicateFields, collection));
    const existingValues = new Map(duplicateCollections.map(collection => [collection,
      new Set(currentRecords.get(collection).map(record => normalizedKey(record[duplicateFields[collection]])))]));
    const newValues = new Map(duplicateCollections.map(collection => [collection, new Map()]));
    for (const node of nodes) {
      if (node.existingId || !Object.hasOwn(duplicateFields, node.collection)) continue;
      const normalized = normalizedKey(node.data[duplicateFields[node.collection]]);
      const values = newValues.get(node.collection), prior = values.get(normalized) || { count: 0, hasNonempty: false };
      values.set(normalized, { count: prior.count + 1, hasNonempty: prior.hasNonempty || Boolean(node.data[duplicateFields[node.collection]]) });
    }
    for (const node of nodes) {
      if (node.existingId || !Object.hasOwn(duplicateFields, node.collection)) continue;
      const field = duplicateFields[node.collection], normalized = normalizedKey(node.data[field]);
      if (node.data[field] && existingValues.get(node.collection).has(normalized)) reject(node, 'Existing ' + field + ' requires explicit source reconciliation; no record was inferred');
      // Preserve in-batch duplicate precedence over existing-value errors. Every
      // conflicting new source row is rejected, including earlier invalid rows.
      const group = newValues.get(node.collection).get(normalized);
      // Raw empty values trigger no check themselves, but historically a raw
      // whitespace value also collides with other raw-empty rows in this batch.
      if (group.count > 1 && group.hasNonempty) reject(node, 'Duplicate ' + field + ' in this batch');
    }
    const ordered = [];
    const visiting = new Set(), visited = new Set();
    function dependency(collection, externalId) {
      const key = keyOf(collection, externalId), node = index.get(key), mapping = mappings.get(key);
      if (node) { visit(node); if (node.entry.status === 'Error') throw failure(400, 'Referenced source row has errors'); return node.existingId || 'staged-' + hash(key).slice(0, 40); }
      if (!mapping) throw failure(400, 'Unmapped ' + collection + ' source identifier');
      const current = get(collection, mapping.record_id);
      if (mapping.record_hash !== hash(current)) throw failure(409, 'Previously mapped dependency changed; reconcile before reuse');
      return mapping.record_id;
    }
    function payload(node, resolve) {
      const d = node.data;
      if (node.collection === 'constituents') return { name: d.name, email: d.email, phone: d.phone, type: d.type, ...(Object.hasOwn(d,'sourceAdditionalTypes') ? {additionalTypes:d.sourceAdditionalTypes} : {}), household: d.household, parentId: d.parentSourceId ? resolve('constituents', d.parentSourceId) : null, contacts: d.sourceContacts || [], segments: d.segments, preference: d.preference, notes: d.notes };
      if (node.collection === 'communications') return { constituentId: resolve('constituents', d.constituentSourceId), subject: d.subject, channel: d.channel, status: d.status, date: d.date, body: d.body, notes: d.notes };
      if (node.collection === 'campaigns') return { name: d.name, type: d.type, goal: d.goalCents, startDate: d.startDate, endDate: d.endDate, status: d.status, description: d.description };
      if (node.collection === 'designations') return { name: d.name, school: d.school, parentId: d.parentSourceId ? resolve('designations', d.parentSourceId) : null, accountCode: d.accountCode, description: d.description };
      return { constituentId: resolve('constituents', d.donorSourceId), amount: d.amountCents, type: d.type, method: d.method, date: d.date, campaignId: d.campaignSourceId ? resolve('campaigns', d.campaignSourceId) : null, allocations: d.sourceAllocations.map(a => ({ designationId: resolve('designations', a.designationSourceId), amount: a.amount })), externalRef: d.externalRef, notes: d.notes, tribute: d.tribute, softCreditId: d.softCreditSourceId ? resolve('constituents', d.softCreditSourceId) : null, pledge: '', pledgeId: null, grantId: null, giftKind: d.giftKind };
    }
    function visit(node) {
      if (visited.has(node.key) || node.entry.status === 'Error') return;
      if (visiting.has(node.key)) { reject(node, 'Source parent hierarchy cycle'); return; }
      visiting.add(node.key);
      try {
        node.payload = payload(node, dependency);
        // The core validator is used whenever references already exist. Staged
        // references were strictly normalized above and are revalidated on commit.
        const refs = node.collection === 'gifts' ? [node.payload.constituentId, node.payload.softCreditId, node.payload.campaignId, ...node.payload.allocations.map(a => a.designationId)] : node.collection === 'communications' ? [node.payload.constituentId] : [node.payload.parentId];
        if (!refs.some(id => id?.startsWith('staged-'))) validate(node.collection, node.payload, node.existingId || null, node.existingId ? get(node.collection, node.existingId) : null);
        if (node.entry.status !== 'Error') ordered.push(node);
      } catch (error) { reject(node, error instanceof z.ZodError ? 'Source values fail the current record contract' : error.message); }
      visiting.delete(node.key); visited.add(node.key);
    }
    for (const node of nodes) visit(node);
    const validNodes = ordered.filter(n => n.entry.status !== 'Error');
    const created = validNodes.filter(n => !n.existingId);
    const count = (values, collection) => values.filter(n => n.collection === collection).length;
    const giftSum = values => values.filter(n => n.collection === 'gifts').reduce((total, n) => total + BigInt(n.data.amountCents), 0n).toString();
    const validGifts = validNodes.filter(n => n.collection === 'gifts');
    const accountCodes = new Set(validNodes.filter(n => n.collection === 'designations').map(n => n.data.accountCode));
    for (const gift of validGifts) for (const allocation of gift.data.sourceAllocations) {
      const staged = index.get(keyOf('designations', allocation.designationSourceId));
      const mapped = mappings.get(keyOf('designations', allocation.designationSourceId));
      const accountCode = staged?.data.accountCode || (mapped && get('designations', mapped.record_id).accountCode);
      if (accountCode) accountCodes.add(accountCode);
    }
    const sourceGiftControls = values => controlTotals(values.filter(n => n.collection === 'gifts').map(n => ({
      type: n.data.type, method: n.data.method, amount: n.data.amountCents,
      allocations: n.data.sourceAllocations.map(a => {
        const staged = index.get(keyOf('designations', a.designationSourceId));
        const mapped = mappings.get(keyOf('designations', a.designationSourceId));
        return { sourceId: a.designationSourceId, amount: a.amount, accountCode: staged?.data.accountCode || (mapped && get('designations', mapped.record_id).accountCode) || '' };
      }),
    })));
    const countedCollections = supported.filter(collection => ['constituents', 'designations', 'gifts'].includes(collection) || input.files.some(file => file.collection === collection));
    const summary = { rowCount: rows.length, validRows: rows.filter(r => r.status !== 'Error').length, errorRows: rows.filter(r => r.status === 'Error').length,
      ...Object.fromEntries(countedCollections.map(collection => [collection, count(validNodes, collection)])),
      createCounts: Object.fromEntries(countedCollections.map(c => [c, count(created, c)])), reusedRows: validNodes.length - created.length,
      giftTotalCents: giftSum(validNodes), newGiftTotalCents: giftSum(created),
      allocationCount: validGifts.reduce((n, g) => n + g.data.sourceAllocations.length, 0),
      allocationTotalCents: validGifts.reduce((sum, g) => sum + g.data.sourceAllocations.reduce((n, a) => n + BigInt(a.amount), 0n), 0n).toString(),
      monetaryContributionCents: giftSum(validGifts.filter(n => !['In-kind', 'Fee payment'].includes(n.data.type))),
      noncashValueCents: giftSum(validGifts.filter(n => n.data.type === 'In-kind')),
      feePaymentCents: giftSum(validGifts.filter(n => n.data.type === 'Fee payment')),
      accountCodeCount: accountCodes.size,
      controlTotals: { all: sourceGiftControls(validNodes), new: sourceGiftControls(created), reused: sourceGiftControls(validNodes.filter(n => n.existingId)) } };
    const valid = summary.errorRows === 0;
    return { valid, replayed: false, source: input.source, fileKey: input.fileKey, scope, rows, summary, contentHash, previewDigest: valid ? digest(contentHash, dependencyHash(currentRecords)) : null, nodes: ordered, payload };
  }
  const publicPlan = result => { const { nodes, payload, contentHash, ...visible } = result; return visible; };
  const route = handler => (req, res, next) => { try { handler(req, res); } catch (error) { next(error); } };
  app.post('/api/migration/preview', admin, csrf, route((req, res) => res.json(publicPlan(plan(parseRequest(previewSchema, req.body))))));
  app.post('/api/migration/commit', admin, csrf, route((req, res) => {
    const { previewDigest, ...input } = parseRequest(commitSchema, req.body);
    const outcome = transaction(() => {
      const result = plan(input);
      if (!result.valid) throw failure(400, 'Migration has validation errors; preview and resolve every row before commit');
      if (result.previewDigest !== previewDigest) throw failure(409, 'Preview changed or expired; preview the current source, mapping and dependencies again');
      if (result.replayed) return publicPlan(result);
      const batchId = randomUUID(), resolved = new Map(), retained = new Map();
      const retain = mapping => retained.set(keyOf(mapping.collection, mapping.record_id), mapping);
      for (const node of result.nodes) if (node.existingId) retain(db.prepare('SELECT * FROM migration_mapping WHERE source=? AND collection=? AND external_id=?').get(input.source, node.collection, node.data.sourceId));
      const resolve = (collection, externalId) => {
        const key = keyOf(collection, externalId);
        if (resolved.has(key)) return resolved.get(key);
        const mapping = db.prepare('SELECT * FROM migration_mapping WHERE source=? AND collection=? AND external_id=?').get(input.source, collection, externalId);
        if (!mapping) throw failure(400, 'Unmapped source dependency during commit');
        retain(mapping);
        return mapping.record_id;
      };
      const recordIds = [], created = [];
      for (const node of result.nodes) {
        if (node.existingId) { resolved.set(node.key, node.existingId); continue; }
        const inputPayload = result.payload(node, resolve);
        // Establish the native normalization before writing, not from a potentially
        // altered persisted record. Existing defaults and accepted strings remain valid.
        const expected = { ...validate(node.collection, inputPayload) };
        if (node.collection === 'gifts') Object.assign(expected, { status: 'Posted', schoolYear: schoolYear(expected.date) });
        const record = create(node.collection, inputPayload, req.user);
        resolved.set(node.key, record.id); recordIds.push({ collection: node.collection, sourceId: node.data.sourceId, recordId: record.id });
        created.push({ node, recordId: record.id, expected });
      }
      const persisted = (collection, id) => {
        try { const record = get(collection, id); if (record.id !== id) throw new Error('Persisted identity changed'); return record; }
        catch { throw failure(409, 'Migration persisted record is missing or changed identity; entire batch rolled back'); }
      };
      // A later create can alter an earlier row or retained dependency. Verify all
      // rows only after every create, before recording their source mapping hashes.
      for (const mapping of retained.values()) if (hash(persisted(mapping.collection, mapping.record_id)) !== mapping.record_hash) throw failure(409, 'Migration retained record or dependency changed during commit; entire batch rolled back');
      const generated = new Set(['id', 'version', 'createdAt', 'updatedAt']);
      for (const item of created) {
        item.record = persisted(item.node.collection, item.recordId);
        if (!z.object({ id: z.uuid(), version: z.literal(1), createdAt: z.string().datetime(), updatedAt: z.string().datetime() }).safeParse(item.record).success) throw failure(409, 'Migration persisted creation metadata is invalid; entire batch rolled back');
        const values = Object.fromEntries(Object.entries(item.record).filter(([key]) => !generated.has(key)));
        if (hash(values) !== hash(item.expected)) throw failure(409, 'Migration persisted field reconciliation failed: fields or dependencies differ from normalized source; entire batch rolled back');
      }
      for (const { node, recordId, record } of created) {
        db.prepare('INSERT INTO migration_mapping VALUES(?,?,?,?,?,?,?)').run(input.source, node.collection, node.data.sourceId, recordId, node.sourceHash, hash(record), batchId);
      }
      const sourceRecords = result.nodes.map(node => ({ collection: node.collection, sourceId: node.data.sourceId, recordId: resolved.get(node.key), reused: Boolean(node.existingId) }));
      const actualNewControlTotals = controlTotals(recordIds.filter(r => r.collection === 'gifts').map(r => {
        const gift = get('gifts', r.recordId);
        return { type: gift.type, method: gift.method, amount: gift.amount, allocations: gift.allocations.map(a => {
          const mapping = db.prepare("SELECT external_id FROM migration_mapping WHERE source=? AND collection='designations' AND record_id=?").get(input.source, a.designationId);
          if (!mapping) throw failure(409, 'Migration allocation lost its source lineage; entire batch rolled back');
          return { sourceId: mapping.external_id, accountCode: get('designations', a.designationId).accountCode, amount: a.amount };
        }) };
      }));
      const completed = { ...publicPlan(result), batchId, committedAt: new Date().toISOString(), recordIds, sourceRecords,
        sourceFiles: input.files.map((file, index) => ({ file: index + 1, collection: file.collection, rowCount: file.rows.length, mapping: file.mapping })),
        reconciliation: { expectedCreateCounts: result.summary.createCounts, actualCreateCounts: Object.fromEntries(Object.keys(result.summary.createCounts).map(c => [c, recordIds.filter(r => r.collection === c).length])), expectedNewGiftCents: result.summary.newGiftTotalCents,
          actualNewGiftCents: recordIds.filter(r => r.collection === 'gifts').reduce((sum, r) => sum + BigInt(get('gifts', r.recordId).amount), 0n).toString(),
          expectedNewControlTotals: result.summary.controlTotals.new, actualNewControlTotals } };
      if (completed.reconciliation.expectedNewGiftCents !== completed.reconciliation.actualNewGiftCents ||
          hash(completed.reconciliation.expectedCreateCounts) !== hash(completed.reconciliation.actualCreateCounts) ||
          hash(completed.reconciliation.expectedNewControlTotals) !== hash(actualNewControlTotals)) throw failure(409, 'Migration gift reconciliation failed; entire batch rolled back');
      db.prepare('INSERT INTO import_batches VALUES(?,?,?,?,?,?,?,?)').run(batchId, input.source, input.fileKey, result.contentHash, previewDigest, completed.committedAt, req.user.id, JSON.stringify(completed));
      audit(req.user, 'migration_commit', null, batchId, { source: input.source, fileKey: input.fileKey, contentHash: result.contentHash, counts: completed.reconciliation.actualCreateCounts, giftTotalCents: completed.reconciliation.actualNewGiftCents });
      return completed;
    });
    res.status(outcome.replayed ? 200 : 201).json(outcome);
  }));
  // A continuation receipt covers the entire retained source namespace, not
  // only the latest part. It never claims that an unprovided export is complete.
  app.get('/api/migration/source-reconciliation', admin, route((req, res) => {
    const query = z.object({ source: requestShape.source }).strict().safeParse(req.query);
    if (!query.success) throw failure(400, 'Provide a valid migration source namespace');
    const receipt = transaction(() => {
      const source = query.data.source;
      const mappings = db.prepare('SELECT * FROM migration_mapping WHERE source=? ORDER BY collection,external_id').all(source);
      const mappedCounts = Object.fromEntries(supported.map(c => [c, 0]));
      const currentCounts = Object.fromEntries(supported.map(c => [c, 0]));
      const records = new Map(supported.map(c => [c, []]));
      const integrity = { unchanged: 0, changed: 0, missing: 0, duplicateTargets: 0, reconciled: true };
      const targets = new Set();
      for (const mapping of mappings) {
        if (!supported.includes(mapping.collection)) throw failure(503, 'Migration source contains an unsupported retained collection; reconcile the source ledger');
        mappedCounts[mapping.collection]++;
        const target = keyOf(mapping.collection, mapping.record_id);
        if (targets.has(target)) integrity.duplicateTargets++;
        targets.add(target);
        let record;
        try { record = get(mapping.collection, mapping.record_id); }
        catch { integrity.missing++; continue; }
        if (record.id !== mapping.record_id) { integrity.missing++; continue; }
        currentCounts[mapping.collection]++;
        if (hash(record) === mapping.record_hash) integrity.unchanged++;
        else integrity.changed++;
        records.get(mapping.collection).push({ record, mapping });
      }
      integrity.reconciled = integrity.changed === 0 && integrity.missing === 0 && integrity.duplicateTargets === 0;
      const base = { source, scope: 'All retained mappings and current native records for this source namespace. A reconciled receipt proves unchanged mapped rows, not completeness of an unprovided buyer export. Each committed part is atomic; a multi-part import is not one transaction.',
        batchCount: db.prepare('SELECT count(*) n FROM import_batches WHERE source=?').get(source).n,
        mappingCount: mappings.length, mappedCounts, currentCounts, integrity };
      // Do not present totals as exact reconciled source controls when one mapped
      // record is missing or has subsequently undergone an authorized correction.
      if (!integrity.reconciled) return { ...base, constituents: null, designations: null, gifts: null, campaigns: null, communications: null };
      const people = records.get('constituents').map(item => item.record);
      const grouped = (values, field) => {
        const groups = new Map();
        for (const value of values) groups.set(value[field], (groups.get(value[field]) || 0) + 1);
        return [...groups].map(([key, count]) => ({ key, count })).sort((a, b) => a.key.localeCompare(b.key));
      };
      const funds = records.get('designations');
      const codes = funds.map(({ record, mapping }) => ({ sourceId: mapping.external_id, accountCode: record.accountCode })).sort((a, b) => a.sourceId.localeCompare(b.sourceId));
      const fundMappings = new Map(funds.map(item => [item.record.id, item.mapping]));
      const gifts = records.get('gifts').map(item => item.record);
      const finance = controlTotals(gifts.map(gift => ({ type: gift.type, method: gift.method, amount: gift.amount,
        allocations: gift.allocations.map(allocation => {
          const mapping = fundMappings.get(allocation.designationId);
          if (!mapping) throw failure(409, 'Mapped gift allocation has no retained designation in this source namespace; reconcile source lineage');
          return { sourceId: mapping.external_id, accountCode: get('designations', allocation.designationId).accountCode, amount: allocation.amount };
        }) })));
      const sum = values => values.reduce((n, gift) => n + BigInt(gift.amount), 0n).toString();
      return { ...base,
        constituents: { profileCount: people.length, contactCount: people.reduce((n, p) => n + p.contacts.length, 0), profilesWithContacts: people.filter(p => p.contacts.length).length,
          parentLinkCount: people.filter(p => p.parentId).length, byType: grouped(people, 'type'), byPreference: grouped(people, 'preference') },
        designations: { recordCount: funds.length, accountCodeCount: new Set(codes.map(row => row.accountCode)).size, parentLinkCount: funds.filter(item => item.record.parentId).length, accountCodeDigest: hash(codes) },
        gifts: { giftCount: gifts.length, allocationCount: gifts.reduce((n, g) => n + g.allocations.length, 0), totalCents: sum(gifts),
          allocationTotalCents: gifts.reduce((n, g) => n + g.allocations.reduce((a, row) => a + BigInt(row.amount), 0n), 0n).toString(),
          monetaryContributionCents: sum(gifts.filter(g => !['In-kind', 'Fee payment'].includes(g.type))), noncashValueCents: sum(gifts.filter(g => g.type === 'In-kind')),
          feePaymentCents: sum(gifts.filter(g => g.type === 'Fee payment')), byType: finance.byType, byMethod: finance.byMethod, designationControlDigest: hash(finance.byDesignation) },
        campaigns: { recordCount: currentCounts.campaigns }, communications: { recordCount: currentCounts.communications } };
    });
    res.json(receipt);
  }));
  app.get('/api/migration/batches/:id', admin, route((req, res) => {
    if (!z.uuid().safeParse(req.params.id).success) throw failure(400, 'Invalid migration batch identifier');
    const row = db.prepare('SELECT source,content_hash,result FROM import_batches WHERE id=?').get(req.params.id);
    if (!row) throw failure(404, 'Migration batch not found');
    const batch = JSON.parse(row.result);
    // Committed reconciliation stays immutable even after authorized corrections.
    // Current integrity is separate, and historical batches without sourceRecords
    // explicitly cover only the rows newly created by that original batch.
    const lineage = (batch.sourceRecords || batch.recordIds || []).map(record => {
      const mapping = db.prepare('SELECT * FROM migration_mapping WHERE source=? AND collection=? AND external_id=?').get(row.source, record.collection, record.sourceId);
      let status = 'Missing';
      if (mapping && mapping.record_id === record.recordId) {
        try { status = hash(get(record.collection, record.recordId)) === mapping.record_hash ? 'Unchanged' : 'Changed'; } catch { status = 'Missing'; }
      }
      return { ...record, originalBatchId: mapping?.batch_id || null, status };
    });
    res.json({ batch, sourceFingerprint: row.content_hash, lineageCoverage: batch.sourceRecords ? 'All batch source rows' : 'Newly created rows only',
      lineage, integrity: { unchanged: lineage.filter(r => r.status === 'Unchanged').length, changed: lineage.filter(r => r.status === 'Changed').length, missing: lineage.filter(r => r.status === 'Missing').length } });
  }));
  app.get('/api/migration/batches', admin, route((req, res) => {
    const query = z.object({ limit: z.coerce.number().int().min(1).max(100).default(25), cursor: z.string().min(1).max(400).regex(/^[A-Za-z0-9_-]+$/).optional() }).strict().safeParse(req.query);
    if (!query.success) throw failure(400, 'Invalid migration history pagination');
    let cursor = null;
    if (query.data.cursor) {
      try {
        const bytes = Buffer.from(query.data.cursor, 'base64url');
        if (bytes.toString('base64url') !== query.data.cursor) throw new Error('Noncanonical cursor');
        cursor = z.object({ committedAt: z.string().datetime({ offset: true }).max(40), id: z.uuid() }).strict().parse(JSON.parse(bytes.toString('utf8')));
      } catch { throw failure(400, 'Invalid migration history cursor'); }
    }
    // Project JSON in SQLite so source rows and mapping/lineage arrays are never
    // loaded or serialized for a list page. The indexed tuple is stable for ties
    // and does not need a full-table count or an increasingly costly offset.
    const projection = `SELECT id,source,file_key,committed_at,
      json_remove(json_extract(result,'$.summary'),'$.controlTotals') AS summary,
      json_remove(json_extract(result,'$.reconciliation'),'$.expectedNewControlTotals','$.actualNewControlTotals') AS reconciliation,
      json_extract(result,'$.valid') AS valid,json_extract(result,'$.replayed') AS replayed
      FROM import_batches`;
    const sql = projection + (cursor ? ' WHERE (committed_at,id)<(?,?)' : '') + ' ORDER BY committed_at DESC,id DESC LIMIT ?';
    const records = db.prepare(sql).all(...(cursor ? [cursor.committedAt, cursor.id] : []), query.data.limit + 1);
    const page = records.slice(0, query.data.limit);
    const batches = page.map(row => ({ batchId: row.id, source: row.source, fileKey: row.file_key, committedAt: row.committed_at,
      summary: row.summary ? JSON.parse(row.summary) : null, reconciliation: row.reconciliation ? JSON.parse(row.reconciliation) : null,
      valid: Boolean(row.valid), replayed: Boolean(row.replayed) }));
    const last = page.at(-1);
    const nextCursor = records.length > query.data.limit && last ? Buffer.from(JSON.stringify({ committedAt: last.committed_at, id: last.id })).toString('base64url') : null;
    res.json({ scope, batches, nextCursor });
  }));
}
