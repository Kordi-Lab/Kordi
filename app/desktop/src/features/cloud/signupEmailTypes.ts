import type { CanonicalAvatarMutation } from './canonicalAvatar';

export type CloudSignupCodeChallenge = {
  verificationId: string;
  expiresAt: string;
  retryAfterSeconds: number;
};

export type CloudSignupInput = {
  email: string;
  password: string;
  verificationId: string;
  verificationCode: string;
  displayName?: string;
  avatarSeed: string;
  avatarMutation?: CanonicalAvatarMutation;
};
