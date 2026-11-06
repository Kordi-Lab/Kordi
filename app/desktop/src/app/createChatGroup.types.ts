export type CreateChatGroupRequest = {
  avatarDataUrl?: string | null;
  name?: string | null;
  contactIds: string[];
  /** Started to share an invitation link: one other person is enough, since
   * the server needs two active members before an admin can create a link. */
  inviteLink?: boolean;
};
