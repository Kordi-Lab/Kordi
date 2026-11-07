import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { ErrorLine } from '@/components/ui/ErrorLine';
import { SettingsRow, SettingsSection } from '@/kordi-app/components';
import { EditableIdentityAvatar } from '@/kordi-app/components/EditableIdentityAvatar';
import { CloudAccountEmailRow } from '@/kordi-app/cloud/CloudAccountEmailRow';
import { CloudProfileFieldRow } from '@/kordi-app/cloud/CloudProfileFieldRow';
import { openOrganizationJoinDialog } from '@/features/organizations/organizationJoinPrompt';
import type {
  CloudAccount,
  CloudAccountEmailVerificationInput,
  CloudSignupCodeChallenge,
} from '@/features/cloud/authClient';
import { cn } from '@/lib/utils';
import {
  BIRTHDAY_MIN,
  CLOUD_PROFILE_LIMITS,
  cloudProfileHandleDraft,
  cloudProfileNumberPlaceholder,
  kordiIdLockedUntilLabel,
  localDateString,
  sanitizeKordiHandleInput,
  timeZoneOptions,
} from './cloudProfileDraft';
import { KordiIdChangeConfirmDialog, KordiIdLockedDialog } from './CloudProfileKordiIdDialogs';
import type { CloudProfileEditor } from './useCloudProfileEditor';

function AboutTextarea({ id, value, onChange }: { id: string; value: string; onChange: (value: string) => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${element.scrollHeight}px`;
  }, [value]);
  return (
    <textarea
      ref={ref}
      id={id}
      rows={1}
      value={value}
      maxLength={CLOUD_PROFILE_LIMITS.about}
      onChange={(event) => onChange(event.currentTarget.value)}
      className="app-cloud-profile-input app-cloud-profile-textarea"
      placeholder="Add a bio"
    />
  );
}

export function CloudProfilePanel({
  account,
  editor,
  onRequestEmailCode,
  onVerifyEmail,
  onEmailAlreadyVerified,
  onSignOut,
  onClose,
}: {
  account: CloudAccount;
  editor: CloudProfileEditor;
  onRequestEmailCode?: () => Promise<CloudSignupCodeChallenge>;
  onVerifyEmail?: (input: CloudAccountEmailVerificationInput) => Promise<void>;
  onEmailAlreadyVerified?: () => Promise<void>;
  onSignOut?: () => Promise<void> | void;
  onClose: () => void;
}) {
  const idPrefix = useId();
  const id = (name: string) => `${idPrefix}-${name}`;
  const { fieldDraft, errors } = editor;
  const zones = useMemo(() => timeZoneOptions(), []);
  const today = localDateString();
  const kordiIdPlaceholder = cloudProfileNumberPlaceholder(account);
  const kordiIdLockedUntil = kordiIdLockedUntilLabel(account);
  const displayName = account.displayName?.trim() || account.primaryEmail?.trim() || 'Profile';
  const email = account.primaryEmail?.trim();
  const [kordiIdDialog, setKordiIdDialog] = useState<'confirm' | 'locked' | null>(null);
  // Closing the locked dialog returns focus to the field; that focus must not reopen it.
  const skipLockedFocusRef = useRef(false);
  const kordiIdChanged = fieldDraft.kordiId !== cloudProfileHandleDraft(account.kordiId);

  const openLockedDialog = () => {
    if (kordiIdLockedUntil) setKordiIdDialog('locked');
  };
  const closeLockedDialog = () => {
    skipLockedFocusRef.current = true;
    window.setTimeout(() => { skipLockedFocusRef.current = false; }, 0);
    setKordiIdDialog(null);
  };
  const requestSave = () => {
    if (kordiIdChanged) {
      setKordiIdDialog('confirm');
      return;
    }
    void editor.save();
  };

  const textField = (field: 'location' | 'website', label: string, placeholder: string) => (
    <CloudProfileFieldRow label={label} htmlFor={id(field)} error={errors[field]} errorId={id(`${field}-error`)} invalid={Boolean(errors[field])}>
      <input
        id={id(field)}
        inputMode={field === 'website' ? 'url' : undefined}
        value={fieldDraft[field]}
        maxLength={CLOUD_PROFILE_LIMITS[field]}
        onChange={(event) => editor.setField(field, event.currentTarget.value)}
        className="app-cloud-profile-input"
        placeholder={placeholder}
        aria-invalid={Boolean(errors[field]) || undefined}
        aria-describedby={errors[field] ? id(`${field}-error`) : undefined}
      />
    </CloudProfileFieldRow>
  );

  return (
    <div className="app-cloud-account-settings-section app-cloud-account-profile max-w-[620px]">
      <SettingsSection title="Profile">
        <div className="py-4">
          <EditableIdentityAvatar
            kind="human"
            seed={account.avatar.seed}
            name={editor.displayNameDraft || displayName}
            imageUrl={editor.avatarUrlDraft || undefined}
            className="h-16 w-16 border border-white/10"
            label="Profile avatar"
            generateLabel="Random avatar"
            onUpload={editor.uploadAvatar}
            onGenerate={editor.generateAvatar}
          />
        </div>
        <CloudProfileFieldRow label="Name" htmlFor={id('name')} error={errors.displayName} errorId={id('name-error')} invalid={Boolean(errors.displayName)}>
          <input
            id={id('name')}
            value={editor.displayNameDraft}
            onChange={(event) => editor.setDisplayName(event.currentTarget.value)}
            className="app-cloud-profile-input"
            placeholder="Your name"
            aria-invalid={Boolean(errors.displayName) || undefined}
            aria-describedby={errors.displayName ? id('name-error') : undefined}
          />
        </CloudProfileFieldRow>
        <CloudProfileFieldRow
          label="Kordi ID"
          htmlFor={id('kordi-id')}
          error={errors.kordiId}
          errorId={id('kordi-id-error')}
          invalid={Boolean(errors.kordiId)}
        >
          <span className="app-cloud-profile-at" aria-hidden="true">@</span>
          <input
            id={id('kordi-id')}
            value={fieldDraft.kordiId}
            onChange={(event) => editor.setField('kordiId', sanitizeKordiHandleInput(event.currentTarget.value))}
            className="app-cloud-profile-input"
            placeholder={kordiIdPlaceholder}
            readOnly={Boolean(kordiIdLockedUntil)}
            onMouseDown={kordiIdLockedUntil ? (event) => { event.preventDefault(); openLockedDialog(); } : undefined}
            onFocus={kordiIdLockedUntil ? () => {
              if (skipLockedFocusRef.current) {
                skipLockedFocusRef.current = false;
                return;
              }
              openLockedDialog();
            } : undefined}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            aria-invalid={Boolean(errors.kordiId) || undefined}
            aria-describedby={errors.kordiId ? id('kordi-id-error') : undefined}
          />
        </CloudProfileFieldRow>
        <CloudProfileFieldRow label="About" htmlFor={id('about')} error={errors.about} errorId={id('about-error')} invalid={Boolean(errors.about)} top>
          <AboutTextarea id={id('about')} value={fieldDraft.about} onChange={(value) => editor.setField('about', value)} />
        </CloudProfileFieldRow>
        {textField('location', 'Location', 'Add your location')}
        <CloudProfileFieldRow label="Time zone" htmlFor={id('time-zone')} error={errors.timeZone} errorId={id('time-zone-error')} invalid={Boolean(errors.timeZone)}>
          <select
            id={id('time-zone')}
            value={fieldDraft.timeZone}
            onChange={(event) => editor.setField('timeZone', event.currentTarget.value)}
            className="app-cloud-profile-input app-cloud-profile-select"
            aria-invalid={Boolean(errors.timeZone) || undefined}
          >
            <option value="">Automatic</option>
            {fieldDraft.timeZone && !zones.some((zone) => zone.value === fieldDraft.timeZone)
              ? <option value={fieldDraft.timeZone}>{fieldDraft.timeZone}</option>
              : null}
            {zones.map((zone) => <option key={zone.value} value={zone.value}>{zone.label}</option>)}
          </select>
          <ChevronDown aria-hidden="true" className="app-cloud-profile-chevron h-3.5 w-3.5 shrink-0" />
        </CloudProfileFieldRow>
        {textField('website', 'Website', 'Add your website')}
        <CloudProfileFieldRow label="Birthday" htmlFor={id('birthday')} error={errors.birthday} errorId={id('birthday-error')} invalid={Boolean(errors.birthday)}>
          <input
            id={id('birthday')}
            type="date"
            min={BIRTHDAY_MIN}
            max={today}
            value={fieldDraft.birthday}
            onChange={(event) => editor.setField('birthday', event.currentTarget.value)}
            className={cn('app-cloud-profile-input app-cloud-profile-date', !fieldDraft.birthday && 'app-cloud-profile-date-empty')}
            aria-invalid={Boolean(errors.birthday) || undefined}
          />
          {fieldDraft.birthday ? (
            <button type="button" className="app-cloud-profile-clear" aria-label="Clear birthday" onClick={() => editor.setField('birthday', '')}>
              <X className="h-3 w-3" />
            </button>
          ) : null}
        </CloudProfileFieldRow>
        {email ? (
          <CloudAccountEmailRow
            key={account.accountId}
            layout="profile"
            email={email}
            verified={account.primaryEmailVerified}
            onRequestCode={onRequestEmailCode}
            onVerify={onVerifyEmail}
            onAlreadyVerified={onEmailAlreadyVerified}
          />
        ) : null}
      </SettingsSection>
      {/* Email ends the table; the Save row follows after a gap, without a hairline. */}
      <div className="app-cloud-profile-save pt-6">
        <SettingsRow
          className="pt-0"
          title="Save changes"
          description={errors.form
            ? <ErrorLine id={id('form-error')} className="mt-0">{errors.form}</ErrorLine>
            : undefined}
          control={(
            <Button type="button" className="h-8 rounded-lg px-3.5 text-[12px]" disabled={editor.isSaving || !editor.isDirty} onClick={requestSave}>
              {editor.isSaving ? 'Saving…' : 'Save'}
            </Button>
          )}
        />
      </div>
      <SettingsSection title="Organizations">
        <SettingsRow
          title="Find your organization"
          className="app-cloud-account-settings-meta-row"
          control={(
            <Button type="button" variant="secondary" className="h-8 rounded-lg px-3.5 text-[12px]" onClick={openOrganizationJoinDialog}>
              Find
            </Button>
          )}
        />
      </SettingsSection>
      {onSignOut ? (
        <SettingsSection title="Session">
          <SettingsRow
            title="Sign out"
            description="Sign out of Kordi on this Mac."
            className="app-cloud-account-settings-meta-row"
            control={(
              <Button
                type="button"
                variant="secondary"
                className="h-8 rounded-lg border border-rose-400/20 bg-rose-500/10 px-3.5 text-[12px] text-rose-200 hover:bg-rose-500/15 hover:text-rose-100"
                disabled={editor.isSigningOut}
                onClick={() => { void editor.signOut(onSignOut, onClose); }}
              >
                {editor.isSigningOut ? 'Signing out…' : 'Sign out'}
              </Button>
            )}
          />
        </SettingsSection>
      ) : null}
      {kordiIdDialog === 'confirm' ? (
        <KordiIdChangeConfirmDialog
          onCancel={() => setKordiIdDialog(null)}
          onConfirm={() => {
            setKordiIdDialog(null);
            void editor.save();
          }}
        />
      ) : null}
      {kordiIdDialog === 'locked' && kordiIdLockedUntil ? (
        <KordiIdLockedDialog availableOn={kordiIdLockedUntil} onClose={closeLockedDialog} />
      ) : null}
    </div>
  );
}
