export type CreateChatGroupRequest = {
  name?: string | null;
  contactIds: string[];
  /** Turn PiP on right after the group is created. Off unless the creator asks. */
  pipEnabled?: boolean;
};
