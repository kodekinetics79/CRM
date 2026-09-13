import { useEffect, useRef, useState } from 'react';
import WorkspaceChecks from '../components/WorkspaceChecks';
import { Download, Plus, Settings2, Shield, Users, X } from 'lucide-react';
import { dateLabel, download, today } from '../lib.js';

const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const blankUser = () => ({ name: '', email: '', password: '', role: 'staff' });

export default function Settings({ settings, audit = [], onSave, onAccessChanged, api, notify, user }) {
  const [draft, setDraft] = useState({ organizationName: settings?.organizationName || '', fiscalStartMonth: settings?.fiscalStartMonth || 7 });
  const [users, setUsers] = useState([]);
  const [usersLoading, setUsersLoading] = useState(true);
  const [editingUser, setEditingUser] = useState(false);
  const [newUser, setNewUser] = useState(blankUser);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [usersError, setUsersError] = useState('');
  const [success, setSuccess] = useState('');
  const [accessDraft, setAccessDraft] = useState(null);
  const accessField = useRef(null);
  const accessTrigger = useRef(null);
  useEffect(() => { if (accessDraft) accessField.current?.focus(); }, [accessDraft?.id]);
  const closeAccess = () => { setAccessDraft(null); accessTrigger.current?.focus(); };

  useEffect(() => { setDraft({ organizationName: settings?.organizationName || '', fiscalStartMonth: settings?.fiscalStartMonth || 7 }); }, [settings?.organizationName, settings?.fiscalStartMonth]);
  useEffect(() => {
    let active = true;
    if (user?.role !== 'admin') { setUsersLoading(false); return; }
    setUsersLoading(true);
    api('/users').then(result => { if (active) { setUsers(result.users); setUsersError(''); } }).catch(err => { if (active) setUsersError(err.message || 'Unable to load users.'); }).finally(() => { if (active) setUsersLoading(false); });
    return () => { active = false; };
  }, [api, user?.role]);

  const announce = message => { setSuccess(message); notify?.(message); };
  const changeDraft = event => setDraft(current => ({ ...current, [event.target.name]: event.target.name === 'fiscalStartMonth' ? Number(event.target.value) : event.target.value }));
  async function saveSettings(event) {
    event.preventDefault(); setBusy('settings'); setError(''); setSuccess('');
    try { await onSave({ organizationName: draft.organizationName.trim(), fiscalStartMonth: Number(draft.fiscalStartMonth) }); announce('Workspace settings saved.'); }
    catch (err) { setError(err.message || 'Unable to save settings.'); }
    finally { setBusy(''); }
  }
  async function createUser(event) {
    event.preventDefault(); setBusy('user'); setError(''); setSuccess('');
    try {
      await api('/users', { method: 'POST', body: { ...newUser, name: newUser.name.trim(), email: newUser.email.trim() } });
      const result = await api('/users'); setUsers(result.users); setNewUser(blankUser()); setEditingUser(false); announce('User created.');
    } catch (err) { setError(err.message || 'Unable to create user.'); }
    finally { setBusy(''); }
  }
  async function exportSnapshot() {
    setBusy('backup'); setError(''); setSuccess('');
    try { const snapshot = await api('/backup'); download(`foundation-workspace-${today()}.json`, JSON.stringify(snapshot, null, 2), 'application/json'); announce('Workspace snapshot exported.'); }
    catch (err) { setError(err.message || 'Unable to export snapshot.'); }
    finally { setBusy(''); }
  }
  async function saveAccess(event) {
    event.preventDefault(); setBusy('access'); setError(''); setSuccess('');
    try {
      const result = await api(`/users/${accessDraft.id}`, { method: 'PATCH', body: { version: accessDraft.version, role: accessDraft.role, active: accessDraft.active } });
      setUsers(current => current.map(account => account.id === result.user.id ? result.user : account));
      closeAccess(); announce('Access saved. Changed accounts must sign in again.');
      if (result.user.id === user.id) await api('/auth/me');
      else await onAccessChanged?.();
    } catch (err) {
      setError(err.message || 'Unable to update access.');
      try { const result = await api('/users'); setUsers(result.users); setAccessDraft(null); } catch { /* Authentication expiry is handled by the application. */ }
    } finally { setBusy(''); }
  }

  if (user?.role !== 'admin') return <section className="panel"><h2 className="section-title">Administrator access required</h2><p className="subtle">Workspace administration is available to administrators.</p></section>;

  return <div className="settings-page">
    {error && <div className="error-banner" role="alert">{error}</div>}
    {success && <p className="subtle" role="status">{success}</p>}
    <section className="panel">
      <div className="toolbar"><h2 className="section-title"><Settings2 size={18} aria-hidden="true" /> Workspace preferences</h2><span className="badge">Administrator</span></div>
      <p className="subtle">Set the organization name and how transactions are grouped into school years.</p>
      <form onSubmit={saveSettings}>
        <div className="form-grid">
          <label className="field">Organization name<input name="organizationName" value={draft.organizationName} onChange={changeDraft} required maxLength={250} disabled={!!busy} autoComplete="organization" /></label>
          <label className="field">Fiscal year starts in<select name="fiscalStartMonth" value={draft.fiscalStartMonth} onChange={changeDraft} disabled={!!busy}>{months.map((month, index) => <option key={month} value={index + 1}>{month}</option>)}</select></label>
        </div>
        <p className="subtle">July is the pilot default. Confirm the official fiscal calendar before importing operational data. Changing this setting recalculates gift school years.</p>
        <div className="form-actions"><button className="btn btn-primary" type="submit" disabled={!!busy}>{busy === 'settings' ? 'Saving…' : 'Save preferences'}</button></div>
      </form>
    </section>

    <section className="panel">
      <div className="toolbar"><h2 className="section-title"><Users size={18} aria-hidden="true" /> People with access</h2><button className="btn btn-secondary" type="button" aria-expanded={editingUser} aria-controls="create-user-form" disabled={!!busy} onClick={() => { setEditingUser(!editingUser); setError(''); }}>{editingUser ? <X size={16} aria-hidden="true" /> : <Plus size={16} aria-hidden="true" />}{editingUser ? 'Close form' : 'Add user'}</button></div>
      <p className="subtle">Administrators manage settings and users. Staff can edit records. Viewers can read workspace records. Use Manage access to change a role or suspend an account; changes end its existing sessions.</p>
      {accessDraft && <form className="inline-editor" onSubmit={saveAccess} aria-labelledby="access-editor-title">
        <h3 id="access-editor-title">Manage access · {accessDraft.name}</h3>
        <div className="form-grid">
          <label className="field">New access role<select ref={accessField} value={accessDraft.role} disabled={!!busy} onChange={event => setAccessDraft(current => ({ ...current, role: event.target.value }))}><option value="viewer">Viewer · read workspace records</option><option value="staff">Staff · edit records</option><option value="admin">Administrator · manage workspace and accounts</option></select></label>
          <label className="field">Account status<select value={accessDraft.active ? 'active' : 'suspended'} disabled={!!busy} onChange={event => setAccessDraft(current => ({ ...current, active: event.target.value === 'active' }))}><option value="active">Active · can sign in</option><option value="suspended">Suspended · sign-in blocked</option></select></label>
        </div>
        <p className="subtle">Saving a change signs this person out on every device. Suspending preserves their records and activity history. At least one active administrator must remain.</p>
        <div className="form-actions"><button className="btn btn-primary" type="submit" disabled={!!busy}>{busy === 'access' ? 'Saving…' : 'Save access change'}</button><button className="btn btn-secondary" type="button" disabled={!!busy} onClick={closeAccess}>Cancel access change</button></div>
      </form>}
      {editingUser && <form id="create-user-form" className="inline-editor" onSubmit={createUser}>
        <h3>Create user</h3>
        <div className="form-grid">
          <label className="field">Full name<input name="name" autoComplete="name" value={newUser.name} onChange={event => setNewUser(current => ({ ...current, name: event.target.value }))} required maxLength={250} disabled={!!busy} /></label>
          <label className="field">Email address<input name="email" type="email" autoComplete="email" value={newUser.email} onChange={event => setNewUser(current => ({ ...current, email: event.target.value }))} required maxLength={254} disabled={!!busy} /></label>
          <label className="field">Initial password<input name="password" type="password" autoComplete="new-password" value={newUser.password} onChange={event => setNewUser(current => ({ ...current, password: event.target.value }))} required minLength={12} maxLength={200} disabled={!!busy} aria-describedby="password-requirement" /><small id="password-requirement" className="subtle">Use at least 12 characters. This pilot does not provide password reset or MFA.</small></label>
          <label className="field">Access role<select name="role" value={newUser.role} onChange={event => setNewUser(current => ({ ...current, role: event.target.value }))} disabled={!!busy}><option value="staff">Staff</option><option value="viewer">Viewer</option><option value="admin">Administrator</option></select></label>
        </div>
        <div className="form-actions"><button className="btn btn-primary" disabled={!!busy} type="submit">{busy === 'user' ? 'Creating…' : 'Create user'}</button><button className="btn btn-secondary" type="button" disabled={!!busy} onClick={() => { setEditingUser(false); setNewUser(blankUser()); }}>Cancel</button></div>
      </form>}
      {usersError && <div className="error-banner" role="alert">{usersError}</div>}
      {usersLoading ? <p className="subtle" role="status">Loading users…</p> : <div className="table-wrap"><table><caption className="subtle" style={{ textAlign: 'left', paddingBottom: 12 }}>Workspace accounts · {users.length}</caption><thead><tr><th scope="col">Name</th><th scope="col">Email</th><th scope="col">Role</th><th scope="col">Status</th><th scope="col">Access</th></tr></thead><tbody>{users.map(account => <tr key={account.id}><td>{account.name}{account.id === user.id && <span className="subtle"> · You</span>}</td><td>{account.email}</td><td><span className="badge">{account.role === 'admin' ? 'Administrator' : account.role === 'staff' ? 'Staff' : 'Viewer'}</span></td><td>{account.active ? 'Active' : 'Suspended'}</td><td><button className="btn btn-secondary" type="button" disabled={!!busy} aria-label={`Manage access for ${account.name}`} onClick={event => { accessTrigger.current = event.currentTarget; setAccessDraft({ ...account }); setError(''); }}>Manage access</button></td></tr>)}</tbody></table></div>}
    </section>

    <section className="panel">
      <div className="toolbar"><h2 className="section-title"><Download size={18} aria-hidden="true" /> Workspace snapshot</h2><button className="btn btn-secondary" onClick={exportSnapshot} disabled={!!busy} type="button">{busy === 'backup' ? 'Exporting…' : 'Export workspace snapshot'}</button></div>
      <p className="subtle">Download records, preferences, user names and audit history as JSON. Credentials and sessions are excluded. This is a review snapshot; it cannot restore accounts or replace a tested recovery backup.</p>
    </section>

    <WorkspaceChecks api={api}/>
    <section className="panel">
      <h2 className="section-title"><Shield size={18} aria-hidden="true" /> Integration readiness</h2>
      <p className="subtle">This evaluator pilot stores local records. Live email delivery, Google Workspace, Microsoft Office, Stripe payments, SSO and MFA are not configured. Communication drafts are unsent, and payment methods describe recorded gifts. External connections and production security review remain prerequisites for operational use.</p>
    </section>

    <section className="panel">
      <div className="toolbar"><h2 className="section-title">Activity history</h2><span className="subtle">Latest {audit.length} entries</span></div>
      <p className="subtle">Record changes are logged with the signed-in user. Synthetic seed activity is attributed to System.</p>
      {audit.length ? <div className="table-wrap"><table><thead><tr><th scope="col">Date</th><th scope="col">Person</th><th scope="col">Action</th><th scope="col">Area</th></tr></thead><tbody>{audit.map(entry => <tr key={entry.id}><td>{dateLabel(entry.at)}</td><td>{entry.actor === 'system' ? 'System' : users.find(account => account.id === entry.actor)?.name || entry.actor}</td><td>{entry.action.replaceAll('_', ' ')}</td><td>{entry.collection || 'Workspace'}</td></tr>)}</tbody></table></div> : <p className="subtle">No activity recorded yet.</p>}
    </section>
  </div>;
}
