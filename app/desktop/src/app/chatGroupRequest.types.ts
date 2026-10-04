export type CreateChatGroupRequest = {
  avatarDataUrl?: string | null;
  name?: string | null;
  contactIds: string[];
  /** Turn PiP on right after the group is created. Off unless the creator asks. */
  pipEnabled?: boolean;
};
