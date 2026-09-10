import { useEffect, useState, useSyncExternalStore } from 'react';
import { CloudAuthClient, type CloudMessage } from './authClient';
import { loadSession } from './session';
import { parseCloudGroupControl } from './cloudGroupMessages';
import { parseCloudAgentResponse } from './cloudAgentMessages';
import { cloudDirectMessageDisplayText, cloudDirectMessageAction } from './cloudDirectMessages';
import { cloudMessageAttachmentToMessageAttachment, cloudVoiceMessageToMessageVoice } from './cloudAttachments';
import type { Conversation, Message } from '@/kordi-app/types';
import { CHAT_SYNC_LOCAL_STATE_CHANGED_EVENT } from '@/lib/desktopChatSync';

export type ThreadAttention = { conversation_id: string; session_id: string; unread_count: number; thread_unread_count?: number; thread_count: number; next_root_id: string | null; next_message_id: string | null };
export type ThreadPage = { root: CloudMessage; messages: CloudMessage[]; firstUnreadMessageId: string | null; nextAfterSequence: number | null; isThread: boolean };
const listeners = new Set<() => void>();
let navigation: { sessionId: string; messageId?: string; nonce: number } | null = null;
export function requestThreadNavigation(sessionId: string, messageId?: string) {
  navigation = {sessionId, messageId, nonce:(navigation?.nonce ?? 0)+1};
  listeners.forEach(listener => listener());
}
export function useThreadNavigation() {
  return useSyncExternalStore(listener => {listeners.add(listener); return () => {listeners.delete(listener);};}, () => navigation, () => null);
}
export function refreshThreadAttention() { window.dispatchEvent(new Event('kordi-thread-read')); }

export function useThreadAttention(accountId?: string | null) {
  const [state,setState]=useState<{accountId:string; values:Record<string,ThreadAttention>} | null>(null);
  useEffect(() => {
    if(!accountId)return;
    let cancelled=false, running=false, pending=false;
    const client=new CloudAuthClient();
    const refresh=async()=>{
      if(running){pending=true;return;}
      running=true;
      try {
        const session=await loadSession();
        if(session?.accountId!==accountId)return;
        const values:Record<string,ThreadAttention>={};
        let after='';
        for(;;){
          const page=await client.request<ThreadAttention[]>(`/v2/chat/attention${after?`?after=${encodeURIComponent(after)}`:''}`,{headers:{authorization:`Bearer ${session.token}`}},'Could not load unread replies.');
          for(const item of page){values[item.session_id]=item;values[item.conversation_id]=item;}
          if(cancelled || page.length<200)break;
          after=page[page.length-1].conversation_id;
        }
        if(!cancelled && (await loadSession())?.accountId===accountId)setState(current=>current?.accountId===accountId && JSON.stringify(current.values)===JSON.stringify(values)?current:{accountId,values});
      }catch{/* Keep confirmed counts during reconnect. Navigation exposes its own retry. */}
      finally{running=false;if(pending&&!cancelled){pending=false;void refresh();}}
    };
    void refresh();
    const timer=setInterval(()=>void refresh(),2000);
    const onRead=()=>void refresh();
    window.addEventListener('kordi-thread-read',onRead);
    window.addEventListener(CHAT_SYNC_LOCAL_STATE_CHANGED_EVENT,onRead);
    return()=>{cancelled=true;clearInterval(timer);window.removeEventListener('kordi-thread-read',onRead);window.removeEventListener(CHAT_SYNC_LOCAL_STATE_CHANGED_EVENT,onRead);};
  },[accountId]);
  return state && state.accountId===accountId?state.values:undefined;
}

export function threadMessage(message:CloudMessage, conversation:Conversation, accountId:string):Message {
  const group=parseCloudGroupControl(message.body)?.message;
  const agent=parseCloudAgentResponse(message.body);
  const isAgent=group?.senderKind==='agent'||Boolean(agent);
  const own=!isAgent && message.fromAccountId===accountId;
  const sender=group?.senderDisplayName || (own?'You':conversation.name);
  return {
    id:message.messageId,clientMessageId:message.clientMessageId??undefined,reactionTargetMessageId:message.messageId,
    conversationSequence:message.conversationSequence,role:own?'user':isAgent?'external-agent':'person',isOwnMessage:own,
    sender,senderType:isAgent?'agent':'human',text:group?.text??agent?.text??cloudDirectMessageDisplayText(message.body),
    time:new Date(message.createdAt).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}),timestampMs:Date.parse(message.createdAt),
    messageAction:group?.messageAction??agent?.messageAction??cloudDirectMessageAction(message.body)??undefined,
    replyToMessageId:group?.replyToMessageId??agent?.requestId??undefined,
    attachments:(message.attachments??[]).map(cloudMessageAttachmentToMessageAttachment),
    voiceMessage:message.voiceMessage?cloudVoiceMessageToMessageVoice(message.voiceMessage):undefined,
  };
}
