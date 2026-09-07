import { useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import DigestPage from '../../src/features/digest/DigestPage';
import { cloudApiBaseUrl } from '../../src/features/cloud/cloudApiEnvironment';
import { saveSession, clearSession } from '../../src/features/cloud/session';

const base = cloudApiBaseUrl();
if (!import.meta.env.DEV || import.meta.env.VITE_KORDI_DEV_PROFILE !== 'community' || new URL(base).hostname !== '127.0.0.1') {
  throw new Error('This synthetic system preview requires an isolated loopback development API.');
}
function Preview() {
  const [account, setAccount] = useState<string | null>(null);
  const [email, setEmail] = useState('taylor@digest.example');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function signIn(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      if (!email.endsWith('@digest.example')) throw new Error('Use a synthetic @digest.example account.');
      const response = await fetch(`${base}/v1/cloud/auth/login`, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({email,password})});
      const result = await response.json() as {account?:{accountId:string};session?:{token:string;expiresAt:string;deviceId:string};message?:string};
      if (!response.ok || !result.account || !result.session) throw new Error(result.message || 'Could not sign in to the synthetic account.');
      await saveSession({...result.session, accountId:result.account.accountId});
      setPassword(''); setAccount(result.account.accountId);
    } catch (error) { setError(error instanceof Error ? error.message : 'Could not sign in.'); }
    finally { setBusy(false); }
  }
  return <main style={{height:'100vh',display:'flex',flexDirection:'column',background:'var(--app-bg,#fafafa)'}}>
    <aside style={{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'10px 24px',fontSize:12,borderBottom:'1px solid #8883'}}>
      <span>Synthetic system preview · Actual digest component and API</span>
      {account && <button onClick={()=>{void clearSession();setAccount(null);}}>Sign out</button>}
    </aside>
    {account ? <div style={{flex:1,minHeight:0}}><DigestPage accountId={account}/></div> : <form onSubmit={event=>void signIn(event)} style={{maxWidth:380,margin:'10vh auto',display:'grid',gap:14}}>
      <h1>Open the test digest</h1><p>Sign in with the task’s synthetic account. Generated content comes from the connected test model.</p>
      <label>Email<input aria-label="Synthetic email" type="email" required value={email} onChange={event=>setEmail(event.target.value)} style={{display:'block',border:'1px solid #8886',padding:10,width:'100%'}}/></label>
      <label>Password<input aria-label="Synthetic password" type="password" required autoComplete="off" value={password} onChange={event=>setPassword(event.target.value)} style={{display:'block',border:'1px solid #8886',padding:10,width:'100%'}}/></label>
      {error && <p role="alert">{error}</p>}<button disabled={busy} type="submit">{busy?'Signing in…':'Open digest'}</button>
    </form>}
  </main>;
}
createRoot(document.getElementById('root')!).render(<Preview/>);
