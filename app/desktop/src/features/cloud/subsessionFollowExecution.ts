import { CloudAuthClient } from './authClient';
import { loadSession } from './session';
import { acquireDesktopExecutionLease } from './cloudDesktopExecutionLease';
import { encodeCloudAgentResponse, promptTextForCloudAgentMention } from './cloudAgentMessages';
import { fetchDesktopSubsessionSnapshot } from '@/lib/desktopBackgroundSessions';
import { cancelDesktopChatTurn, fetchDesktopChatTurnState, startDesktopChatMessage } from '@/lib/desktop';

const running=new Set<string>();

export async function discoverSubsessionFollowups() {
  const account=await loadSession();
  if (!account) return;
  const client=new CloudAuthClient();
  const requests=await client.pendingAgentSubsessionMessages(account.token);
  for (const request of requests) {
    const key=`${account.accountId}:${request.runId}`;
    if (running.has(key)) continue;
    running.add(key);
    void (async()=>{
      let turnId:string|null=null;
      let lease:Awaited<ReturnType<typeof acquireDesktopExecutionLease>>=null;
      try {
        const source=await fetchDesktopSubsessionSnapshot(request.subsessionId);
        if (!source.canResume) return;
        if ((await loadSession())?.accountId!==account.accountId) return;
        lease=await acquireDesktopExecutionLease(client,account.token,{
          requestMessageId:request.messageId,sessionId:request.subsessionId,ownerAccountId:account.accountId,
          requesterAccountId:request.senderAccountId,prompt:request.text,idempotencyKey:`subsession:${request.messageId}`,
        });
        if (!lease || !await lease.admitted()) return;
        let turn=await startDesktopChatMessage(request.subsessionId,promptTextForCloudAgentMention(request.text),[],null,request.contextMessages??[],[],source.parentSessionId,request.messageId,lease.deadline);
        turnId=turn.id;
        lease.attach(turn.id);
        let last='';
        for (;;) {
          if ((await loadSession())?.accountId!==account.accountId) throw Error('Account changed.');
          const tools=turn.tools.map(tool=>({id:tool.id,name:tool.name,status:tool.status,arguments:'',liveOutput:'',isError:tool.isError}));
          const body=encodeCloudAgentResponse({requestId:request.messageId,text:turn.assistantText,deliveryState:turn.completed ? turn.status==='cancelled'?'cancelled':turn.succeeded?'complete':'failed':'processing', execution:{phase:turn.completed?turn.succeeded?'complete':'failed':'using-tool',summary:'',steps:[],tools,startedAtMs:turn.startedAtMs??Date.now(),updatedAtMs:Date.now(),completed:turn.completed}});
          const signature=JSON.stringify([turn.status,turn.assistantText,tools]);
          if (signature!==last) {await lease.publisher.sendMessage(account.token,request.senderAccountId,body);last=signature;}
          if (turn.completed) break;
          await new Promise(resolve=>setTimeout(resolve,1000));
          turn=await fetchDesktopChatTurnState(turn.id);
        }
      } catch {
        if (turnId) await cancelDesktopChatTurn(turnId).catch(()=>undefined);
        await lease?.cancel().catch(()=>undefined);
      } finally {lease?.dispose();running.delete(key);}
    })();
  }
}
