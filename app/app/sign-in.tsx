import { useState } from 'react';
import { KeyboardAvoidingView, Platform, View } from 'react-native';

import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Screen } from '@/components/ui/Screen';
import { ErrorBanner, errorMessage } from '@/components/ui/States';
import { T } from '@/components/ui/T';
import { TextField } from '@/components/ui/TextField';
import { supabase, supabaseConfigured } from '@/lib/supabase';
import { space } from '@/theme/tokens';

export default function SignIn() {
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [stage, setStage] = useState<'email' | 'code'>('email');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sendCode = async () => {
    const address = email.trim().toLowerCase();
    if (!address.includes('@')) {
      setError('Enter the email address you signed up with.');
      return;
    }
    setBusy(true);
    setError(null);
    const { error: err } = await supabase.auth.signInWithOtp({ email: address, options: { shouldCreateUser: true } });
    setBusy(false);
    if (err) {
      setError(errorMessage(err));
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

  return (
    <Screen edges={['top', 'left', 'right', 'bottom']} scroll={false} style={{ flex: 1, justifyContent: 'center' }}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={{ gap: space.lg, maxWidth: 440, width: '100%', alignSelf: 'center' }}>
          <View>
            <T variant="label" tone="accent">Splitset</T>
            <T variant="display">Sign in</T>
            <T tone="mut">One database for your running and lifting.</T>
          </View>

          {!supabaseConfigured ? (
            <ErrorBanner message="The app has no Supabase keys. Copy app/.env.example to app/.env and restart the dev server." />
          ) : null}

          <Card>
            {stage === 'email' ? (
              <View style={{ gap: space.md }}>
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
                  hint="We email you a six-digit code. No password."
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
                <Button title="Sign in" onPress={verify} loading={busy} />
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
