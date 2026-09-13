import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';

// Phase one accepts explicitly normalized CSV data, not arbitrary source schemas.
const supported = ['constituents', 'designations', 'gifts'];
const fields = {
  constituents: ['sourceId', 'name', 'email', 'phone', 'type', 'household', 'parentSourceId', 'segments', 'preference', 'notes'],
  designations: ['sourceId', 'name', 'school', 'parentSourceId', 'accountCode', 'description'],
  gifts: ['sourceId', 'donorSourceId', 'designationSourceId', 'allocations', 'amount', 'type', 'method', 'date', 'externalRef', 'notes', 'tribute', 'softCreditSourceId', 'giftKind'],
};
const required = {
  constituents: ['sourceId', 'name', 'type'],
  designations: ['sourceId', 'name', 'accountCode'],
  gifts: ['sourceId', 'donorSourceId', 'amount', 'type', 'method', 'date'],
};
const safeKey = z.string().min(1).max(100).refine(v => !['__proto__', 'prototype', 'constructor'].includes(v), 'Unsupported column name');
const fileSchema = z.object({
  collection: z.enum(supported),
  mapping: z.record(safeKey, safeKey),
  rows: z.array(z.record(safeKey, z.string().max(8000))).min(1).max(500),
}).strict().superRefine((file, ctx) => {
  for (const key of Object.keys(file.mapping)) if (!fields[file.collection].includes(key)) ctx.addIssue({ code: 'custom', message: 'Unsupported mapped field: ' + key });
  for (const key of required[file.collection]) if (!Object.hasOwn(file.mapping, key)) ctx.addIssue({ code: 'custom', message: 'Required mapping: ' + key });
  if (file.collection === 'gifts' && Number(Object.hasOwn(file.mapping, 'allocations')) + Number(Object.hasOwn(file.mapping, 'designationSourceId')) !== 1) ctx.addIssue({ code: 'custom', message: 'Map designationSourceId or allocations, exactly one' });
  if (new Set(Object.values(file.mapping)).size !== Object.keys(file.mapping).length) ctx.addIssue({ code: 'custom', message: 'A column cannot map to more than one field' });
  for (const row of file.rows) if (Object.keys(row).length > 30) ctx.addIssue({ code: 'custom', message: 'Maximum 30 columns per row' });
});
const requestShape = {
  source: z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9][A-Za-z0-9 ._-]*$/),
  fileKey: z.string().trim().min(1).max(160),
  files: z.array(fileSchema).min(1).max(10),
};
const previewSchema = z.object(requestShape).strict().refine(v => v.files.reduce((n, f) => n + f.rows.length, 0) <= 500, 'Maximum 500 rows across all files');
const commitSchema = z.object({ ...requestShape, previewDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict().refine(v => v.files.reduce((n, f) => n + f.rows.length, 0) <= 500, 'Maximum 500 rows across all files');
const text = z.string().max(8000);
const short = z.string().max(300);
const sourceId = z.string().trim().min(1).max(100);
const name = z.string().trim().min(1).max(250);
const email = z.union([z.literal(''), z.email().max(254)]);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => Number.isFinite(Date.parse(v)) && new Date(v + 'T00:00:00Z').toISOString().slice(0, 10) === v, 'Invalid source calendar date');
const sourceSchemas = {
  constituents: z.object({ sourceId, name, email, phone: short, type: z.enum(['Individual', 'Business', 'Foundation', 'Alumni', 'Employee', 'Community partner']), household: short, parentSourceId: z.string().max(100), segments: short, preference: z.enum(['Email', 'Phone', 'Post', 'Do not contact']), notes: text }).strict(),
  designations: z.object({ sourceId, name, school: short, parentSourceId: z.string().max(100), accountCode: short.min(1), description: text }).strict(),
  gifts: z.object({ sourceId, donorSourceId: sourceId, designationSourceId: z.string().max(100), allocations: text, amount: z.string(), type: z.enum(['Cash', 'In-kind', 'Grant', 'Fee payment', 'Employee giving', 'Sponsorship']), method: z.enum(['Check', 'Cash', 'Credit card', 'ACH', 'Payroll', 'In-kind']), date, externalRef: short, notes: text, tribute: short, softCreditSourceId: z.string().max(100), giftKind: z.enum(['One-time', 'Recurring', 'Pledge fulfillment', 'Matching gift', 'Planned gift']) }).strict(),
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
function dollarCents(value) {
  if (!/^\d{1,11}(?:\.\d{1,2})?$/.test(value)) throw failure(400, 'Amount must be an exact nonnegative decimal dollar string with at most two decimal places');
  const [whole, fraction = ''] = value.split('.');
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (cents < 1n || cents > 1000000000000n) throw failure(400, 'Amount must be between one cent and the supported gift maximum');
  return Number(cents);
}
function normalize(file, row) {
  const raw = Object.fromEntries(fields[file.collection].map(field => [field, Object.hasOwn(file.mapping, field) ? row[file.mapping[field]] : '']));
  for (const [field, column] of Object.entries(file.mapping)) if (!Object.hasOwn(row, column)) throw failure(400, 'Missing mapped column: ' + field);
  if (file.collection === 'constituents' && !raw.preference) raw.preference = 'Email';
  if (file.collection === 'gifts' && !raw.giftKind) raw.giftKind = 'One-time';
  for (const field of ['sourceId', 'parentSourceId', 'donorSourceId', 'designationSourceId', 'softCreditSourceId']) if (Object.hasOwn(raw, field)) raw[field] = raw[field].trim();
  const parsed = sourceSchemas[file.collection].parse(raw);
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

export function installMigrationRoutes(app, { list, get, create, validate, audit, csrf, admin, transaction, db, collections, schoolYear }) {
  if (!supported.every(c => collections.includes(c))) throw new Error('Migration requires constituents, designations and gifts');
  db.exec(`CREATE TABLE IF NOT EXISTS migration_mapping (
    source TEXT NOT NULL, collection TEXT NOT NULL, external_id TEXT NOT NULL,
    record_id TEXT NOT NULL, source_hash TEXT NOT NULL, record_hash TEXT NOT NULL,
    batch_id TEXT NOT NULL, PRIMARY KEY(source,collection,external_id));
    CREATE TABLE IF NOT EXISTS import_batches (
    id TEXT PRIMARY KEY, source TEXT NOT NULL, file_key TEXT NOT NULL,
    content_hash TEXT NOT NULL, preview_digest TEXT NOT NULL, committed_at TEXT NOT NULL,
    actor TEXT NOT NULL, result TEXT NOT NULL, UNIQUE(source,file_key));`);
  app.delete('/api/records/:collection/:id', csrf, (req,res,next)=>{
    if(db.prepare('SELECT 1 FROM migration_mapping WHERE collection=? AND record_id=?').get(req.params.collection,req.params.id))return res.status(409).json({error:'Migrated source mappings and record history are retained; reconcile through a supported correction instead of deleting this record'});
    next();
  });
  const signingKey = randomBytes(32);
  const scope = 'Phase-one normalized constituent, designation and posted gift conversion only; contracts, attachments, interactions, source voids, recurring execution and full NonProfitEasy history are not converted.';
  const priorBatch = input => db.prepare('SELECT * FROM import_batches WHERE source=? AND file_key=?').get(input.source, input.fileKey);
  const fingerprint = input => hash(input);
  const dependencyHash = () => hash({
    // Including current data as well as versions detects source-reference/duplicate changes.
    records: supported.map(c => [c, list(c).sort((a, b) => a.id.localeCompare(b.id))]),
    mappings: db.prepare('SELECT * FROM migration_mapping ORDER BY source,collection,external_id').all(),
    calendar: [schoolYear('2000-01-01'), schoolYear('2000-07-01')],
  });
  const digest = (contentHash, dependencies) => createHmac('sha256', signingKey).update(contentHash + ':' + dependencies).digest('hex');
  function plan(input) {
    const contentHash = fingerprint(input);
    const previous = priorBatch(input);
    if (previous) {
      if (previous.content_hash !== contentHash) throw failure(409, 'This source/fileKey was already committed with different content or mapping; use a new fileKey and reconcile source conflicts');
      return { ...JSON.parse(previous.result), valid: true, replayed: true, previewDigest: previous.preview_digest, contentHash, nodes: [] };
    }
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
    function duplicate(node, collection, field, value) {
      if (!value || node.existingId) return;
      const normalized = value.trim().toLowerCase();
      if (list(collection).some(r => String(r[field] || '').trim().toLowerCase() === normalized)) reject(node, 'Existing ' + field + ' requires explicit source reconciliation; no record was inferred');
      for (const other of nodes) if (other !== node && other.collection === collection && !other.existingId && String(other.data[field] || '').trim().toLowerCase() === normalized) { reject(node, 'Duplicate ' + field + ' in this batch'); reject(other, 'Duplicate ' + field + ' in this batch'); }
    }
    for (const node of nodes) {
      if (node.collection === 'constituents') duplicate(node, 'constituents', 'email', node.data.email);
      if (node.collection === 'designations') duplicate(node, 'designations', 'accountCode', node.data.accountCode);
      if (node.collection === 'gifts') duplicate(node, 'gifts', 'externalRef', node.data.externalRef);
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
      if (node.collection === 'constituents') return { name: d.name, email: d.email, phone: d.phone, type: d.type, household: d.household, parentId: d.parentSourceId ? resolve('constituents', d.parentSourceId) : null, contacts: [], segments: d.segments, preference: d.preference, notes: d.notes };
      if (node.collection === 'designations') return { name: d.name, school: d.school, parentId: d.parentSourceId ? resolve('designations', d.parentSourceId) : null, accountCode: d.accountCode, description: d.description };
      return { constituentId: resolve('constituents', d.donorSourceId), amount: d.amountCents, type: d.type, method: d.method, date: d.date, campaignId: null, allocations: d.sourceAllocations.map(a => ({ designationId: resolve('designations', a.designationSourceId), amount: a.amount })), externalRef: d.externalRef, notes: d.notes, tribute: d.tribute, softCreditId: d.softCreditSourceId ? resolve('constituents', d.softCreditSourceId) : null, pledge: '', pledgeId: null, grantId: null, giftKind: d.giftKind };
    }
    function visit(node) {
      if (visited.has(node.key) || node.entry.status === 'Error') return;
      if (visiting.has(node.key)) { reject(node, 'Source parent hierarchy cycle'); return; }
      visiting.add(node.key);
      try {
        node.payload = payload(node, dependency);
        // The core validator is used whenever references already exist. Staged
        // references were strictly normalized above and are revalidated on commit.
        const refs = node.collection === 'gifts' ? [node.payload.constituentId, node.payload.softCreditId, ...node.payload.allocations.map(a => a.designationId)] : [node.payload.parentId];
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
    const summary = { rowCount: rows.length, validRows: rows.filter(r => r.status !== 'Error').length, errorRows: rows.filter(r => r.status === 'Error').length,
      constituents: count(validNodes, 'constituents'), designations: count(validNodes, 'designations'), gifts: count(validNodes, 'gifts'),
      createCounts: Object.fromEntries(supported.map(c => [c, count(created, c)])), reusedRows: validNodes.length - created.length,
      giftTotalCents: giftSum(validNodes), newGiftTotalCents: giftSum(created),
      allocationCount: validGifts.reduce((n, g) => n + g.data.sourceAllocations.length, 0),
      allocationTotalCents: validGifts.reduce((sum, g) => sum + g.data.sourceAllocations.reduce((n, a) => n + BigInt(a.amount), 0n), 0n).toString(),
      monetaryContributionCents: giftSum(validGifts.filter(n => !['In-kind', 'Fee payment'].includes(n.data.type))),
      noncashValueCents: giftSum(validGifts.filter(n => n.data.type === 'In-kind')),
      feePaymentCents: giftSum(validGifts.filter(n => n.data.type === 'Fee payment')),
      accountCodeCount: accountCodes.size };
    const valid = summary.errorRows === 0;
    return { valid, replayed: false, source: input.source, fileKey: input.fileKey, scope, rows, summary, contentHash, previewDigest: valid ? digest(contentHash, dependencyHash()) : null, nodes: ordered, payload };
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
      const batchId = randomUUID(), resolved = new Map();
      const resolve = (collection, externalId) => {
        const key = keyOf(collection, externalId);
        if (resolved.has(key)) return resolved.get(key);
        const mapping = db.prepare('SELECT record_id FROM migration_mapping WHERE source=? AND collection=? AND external_id=?').get(input.source, collection, externalId);
        if (!mapping) throw failure(400, 'Unmapped source dependency during commit');
        return mapping.record_id;
      };
      const recordIds = [];
      for (const node of result.nodes) {
        if (node.existingId) { resolved.set(node.key, node.existingId); continue; }
        const record = create(node.collection, result.payload(node, resolve), req.user);
        resolved.set(node.key, record.id); recordIds.push({ collection: node.collection, sourceId: node.data.sourceId, recordId: record.id });
        db.prepare('INSERT INTO migration_mapping VALUES(?,?,?,?,?,?,?)').run(input.source, node.collection, node.data.sourceId, record.id, node.sourceHash, hash(record), batchId);
      }
      const completed = { ...publicPlan(result), batchId, committedAt: new Date().toISOString(), recordIds,
        reconciliation: { expectedCreateCounts: result.summary.createCounts, actualCreateCounts: Object.fromEntries(supported.map(c => [c, recordIds.filter(r => r.collection === c).length])), expectedNewGiftCents: result.summary.newGiftTotalCents,
          actualNewGiftCents: recordIds.filter(r => r.collection === 'gifts').reduce((sum, r) => sum + BigInt(get('gifts', r.recordId).amount), 0n).toString() } };
      if (completed.reconciliation.expectedNewGiftCents !== completed.reconciliation.actualNewGiftCents) throw failure(409, 'Migration gift reconciliation failed; entire batch rolled back');
      db.prepare('INSERT INTO import_batches VALUES(?,?,?,?,?,?,?,?)').run(batchId, input.source, input.fileKey, result.contentHash, previewDigest, completed.committedAt, req.user.id, JSON.stringify(completed));
      audit(req.user, 'migration_commit', null, batchId, { source: input.source, fileKey: input.fileKey, contentHash: result.contentHash, counts: completed.reconciliation.actualCreateCounts, giftTotalCents: completed.reconciliation.actualNewGiftCents });
      return completed;
    });
    res.status(outcome.replayed ? 200 : 201).json(outcome);
  }));
  app.get('/api/migration/batches', admin, route((req, res) => res.json({ scope, batches: db.prepare('SELECT result FROM import_batches ORDER BY committed_at DESC,id DESC LIMIT 100').all().map(r => JSON.parse(r.result)) })));
}
