import { useState } from 'react';
import { KeyboardAvoidingView, Platform, View } from 'react-native';

import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Segmented } from '@/components/ui/Chip';
import { Screen } from '@/components/ui/Screen';
import { ErrorBanner, errorMessage } from '@/components/ui/States';
import { T } from '@/components/ui/T';
import { TextField } from '@/components/ui/TextField';
import { supabase, supabaseConfigured } from '@/lib/supabase';
import { space } from '@/theme/tokens';

type Mode = 'in' | 'new';

const INVITE_ONLY = 'Splitset is invite-only right now. Ask the person who runs it for an invite.';

/** The zone the device is set to, so a new profile starts in the right one without asking. */
function deviceTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** Supabase's "no new accounts here" comes back under two codes; both read the same to a newcomer. */
function signupsOff(e: { code?: string; message?: string }): boolean {
  return e.code === 'signup_disabled' || e.code === 'otp_disabled' || /signups not allowed/i.test(e.message ?? '');
}

/**
 * The front door. One form for both ways in: a returning person gets a code by email, a new one
 * gives their name first, because Supabase creates the account (and so the profile) the moment
 * the code is sent, and only the metadata sent with it reaches the profile row.
 */
export default function SignIn() {
  const [mode, setMode] = useState<Mode>('in');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [stage, setStage] = useState<'email' | 'code'>('email');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sendCode = async () => {
    const address = email.trim().toLowerCase();
    if (mode === 'new' && !name.trim()) {
      setError('Tell us your name so the app can say hello.');
      return;
    }
    if (!address.includes('@')) {
      setError(mode === 'new' ? 'Enter your email address.' : 'Enter the email address you signed up with.');
      return;
    }
    setBusy(true);
    setError(null);
    const { error: err } = await supabase.auth.signInWithOtp({
      email: address,
      options: mode === 'new'
        ? { shouldCreateUser: true, data: { display_name: name.trim(), timezone: deviceTimezone() } }
        : { shouldCreateUser: true },
    });
    setBusy(false);
    if (err) {
      setError(signupsOff(err) ? INVITE_ONLY : errorMessage(err));
      return;
    }
    setStage('code');
  };

  const verify = async () => {
    const token = code.trim();
    if (token.length < 6) {
      setError('The code is six digits.');
      return;
    }
    setBusy(true);
    setError(null);
    const { error: err } = await supabase.auth.verifyOtp({ email: email.trim().toLowerCase(), token, type: 'email' });
    setBusy(false);
    if (err) setError(errorMessage(err));
    // on success the session listener swaps the navigator to (app)
  };

  const switchMode = (next: Mode) => {
    setMode(next);
    setError(null);
  };

  return (
    <Screen edges={['top', 'left', 'right', 'bottom']} scroll={false} style={{ flex: 1, justifyContent: 'center' }}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={{ gap: space.lg, maxWidth: 440, width: '100%', alignSelf: 'center' }}>
          <View>
            <T variant="label" tone="accent">Splitset</T>
            <T variant="display">Welcome to Splitset</T>
            <T tone="mut">Your running, lifting and recovery in one place, straight from your Garmin.</T>
          </View>

          {!supabaseConfigured ? (
            <ErrorBanner message="The app has no Supabase keys. Copy app/.env.example to app/.env and restart the dev server." />
          ) : null}

          {stage === 'email' ? (
            <Segmented<Mode>
              options={[{ value: 'in', label: 'Sign in' }, { value: 'new', label: 'Create account' }]}
              value={mode}
              onChange={switchMode}
            />
          ) : null}

          <Card>
            {stage === 'email' ? (
              <View style={{ gap: space.md }}>
                {mode === 'new' ? (
                  <TextField
                    label="Your name"
                    value={name}
                    onChangeText={setName}
                    placeholder="What should we call you?"
                    autoCapitalize="words"
                    autoComplete="name"
                    textContentType="name"
                    returnKeyType="next"
                  />
                ) : null}
                <TextField
                  label="Email"
                  value={email}
                  onChangeText={setEmail}
                  placeholder="you@example.com"
                  autoCapitalize="none"
                  autoComplete="email"
                  keyboardType="email-address"
                  textContentType="emailAddress"
                  returnKeyType="send"
                  onSubmitEditing={sendCode}
                  hint="We email you a six-digit code. No password, nothing to remember."
                />
                <Button title="Send code" onPress={sendCode} loading={busy} disabled={!supabaseConfigured} />
              </View>
            ) : (
              <View style={{ gap: space.md }}>
                <T tone="mut">Code sent to {email.trim()}. It expires in an hour.</T>
                <TextField
                  label="Six-digit code"
                  value={code}
                  onChangeText={setCode}
                  placeholder="123456"
                  keyboardType="number-pad"
                  textContentType="oneTimeCode"
                  autoComplete="one-time-code"
                  maxLength={8}
                  returnKeyType="done"
                  onSubmitEditing={verify}
                />
                <Button title={mode === 'new' ? 'Create my account' : 'Sign in'} onPress={verify} loading={busy} />
                <Button title="Use a different email" variant="ghost" small onPress={() => { setStage('email'); setCode(''); setError(null); }} />
              </View>
            )}
            <View style={{ marginTop: space.sm }}>
              <ErrorBanner message={error} />
            </View>
          </Card>
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}
