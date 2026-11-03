import { Host, Icon } from '@expo/ui';
import { messageOf, type Prompt } from '@zero/agent-core';
import { router, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { BackHandler, FlatList, Pressable, ScrollView, View } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ScreenHeader } from '@/components/screen-header';
import { Input } from '@/components/ui/input';
import { ListRow } from '@/components/ui/list-row';
import { Text } from '@/components/ui/text';
import { usePrompts } from '@/lib/prompts';
import { useHiddenTabBar } from '@/lib/tab-bar';
import { useColor } from '@/lib/theme';

const PROMPT_ICON = Icon.select({ ios: 'questionmark.bubble', android: import('@expo/material-symbols/live_help.xml') });
const SEND_ICON = Icon.select({ ios: 'paperplane.fill', android: import('@expo/material-symbols/send.xml') });

type Origin = 'home' | 'list';

type Router = ReturnType<typeof useRouter>;

const backToBrowse = () => router.dismissTo('/browse');
const backToPrompts = (nav: Router) => nav.dismissTo('/browse/prompts');
const backToHome = (nav: Router) => {
  nav.dismissTo('/browse');
  nav.navigate('/');
};

export function openPrompt(id: string, from: Origin) {
  router.navigate({ pathname: '/browse/prompt/[id]', params: { id, from } }, { withAnchor: true });
}

function formatCreatedAt(createdAt: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(new Date(createdAt));
}

export function PromptButton() {
  const { prompts } = usePrompts();
  const color = useColor('--color-foreground-secondary');
  const open = (prompts ?? []).filter((prompt) => !prompt.answer);
  const oldest = open.at(-1);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={open.length > 0 ? `Prompts, ${open.length} unanswered` : 'Prompts'}
      onPress={() => {
        if (oldest) openPrompt(oldest.id, 'home');
        else router.navigate('/browse/prompts', { withAnchor: true });
      }}
      className="h-12 w-12 items-center justify-center rounded-full"
    >
      <Host matchContents><Icon name={PROMPT_ICON} size={24} color={color} /></Host>
      {open.length > 0 ? (
        <View className="absolute right-1 top-1 h-[18px] min-w-[18px] items-center justify-center rounded-full bg-accent px-1">
          <Text className="text-[11px] font-semibold text-on-accent">{open.length}</Text>
        </View>
      ) : null}
    </Pressable>
  );
}

function PromptRow({ prompt }: { prompt: Prompt }) {
  const when = formatCreatedAt(prompt.createdAt);
  return (
    <ListRow
      leading={<View className={prompt.seenAt ? 'h-2 w-2' : 'h-2 w-2 rounded-full bg-accent'} />}
      accessibilityLabel={prompt.seenAt ? prompt.title : `New: ${prompt.title}`}
      onPress={() => openPrompt(prompt.id, 'list')}
      className="min-h-12"
    >
      <Text numberOfLines={1} className={prompt.seenAt ? undefined : 'font-semibold'}>{prompt.title}</Text>
      <Text variant="subtitle" numberOfLines={1}>{prompt.answer?.text ?? when}</Text>
    </ListRow>
  );
}

export function PromptsScreen() {
  const { prompts } = usePrompts();
  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title="Prompts" back={{ label: 'Browse', accessibilityLabel: 'Back to Browse', onPress: backToBrowse }} />
      {prompts === null ? null : prompts.length === 0 ? (
        <Text variant="subtitle" className="px-screen-x py-6">No prompts yet.</Text>
      ) : (
        <FlatList data={prompts} keyExtractor={(prompt) => prompt.id} renderItem={({ item }) => <PromptRow prompt={item} />} />
      )}
    </View>
  );
}

export function PromptScreen() {
  const { id, from } = useLocalSearchParams<{ id: string; from?: string }>();
  const { replica, prompts } = usePrompts();
  const prompt = prompts?.find((candidate) => candidate.id === id) ?? null;
  const nav = useRouter();
  const close = useCallback(() => (from === 'home' ? backToHome : backToPrompts)(nav), [from, nav]);
  const insets = useSafeAreaInsets();
  const accent = useColor('--color-accent');
  const muted = useColor('--color-foreground-muted');
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  useHiddenTabBar();

  const missing = prompts !== null && prompt === null;
  const unseen = prompt !== null && prompt.seenAt === null;
  useEffect(() => {
    if (missing) backToPrompts(nav);
  }, [missing, nav]);
  useEffect(() => {
    if (unseen && replica) void replica.prompts.markSeen(id).catch(() => {});
  }, [unseen, replica, id]);
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      close();
      return true;
    });
    return () => sub.remove();
  }, [close]);

  const send = useCallback(async (text: string) => {
    if (!replica || sending || !text.trim()) return;
    setSending(true);
    setError(null);
    try {
      await replica.prompts.answer(id, text);
      close();
    } catch (cause) {
      setError(messageOf(cause));
      setSending(false);
    }
  }, [replica, sending, id, close]);

  if (!prompt) return <View className="flex-1 bg-background" />;
  const answered = prompt.answer?.text ?? null;

  return (
    <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
      <View className="flex-1 bg-background" style={{ paddingBottom: insets.bottom + 12 }}>
        <ScreenHeader
          title={prompt.title}
          back={from === 'home'
            ? { label: 'Home', accessibilityLabel: 'Back to Home', onPress: close }
            : { label: 'Prompts', accessibilityLabel: 'Back to Prompts', onPress: close }}
        />
        <ScrollView className="flex-1" contentContainerClassName="px-screen-x pb-6">
          <Text selectable>{prompt.text}</Text>
        </ScrollView>
        <View className="gap-2 px-screen-x">
          {prompt.suggestions.map((suggestion) => (
            <Pressable
              key={suggestion}
              accessibilityRole="button"
              accessibilityState={{ disabled: answered !== null || sending, selected: answered === suggestion }}
              disabled={answered !== null || sending}
              onPress={() => void send(suggestion)}
              className={answered === suggestion
                ? 'min-h-14 justify-center rounded-dialog bg-accent px-4'
                : 'min-h-14 justify-center rounded-dialog bg-surface-muted px-4'}
            >
              <Text className={answered === suggestion ? 'font-semibold text-on-accent' : 'font-semibold'}>{suggestion}</Text>
            </Pressable>
          ))}
          {answered !== null && !prompt.suggestions.includes(answered) ? (
            <View className="min-h-14 justify-center rounded-dialog bg-accent px-4">
              <Text className="font-semibold text-on-accent">{answered}</Text>
            </View>
          ) : null}
          {answered === null ? (
            <View className="min-h-14 flex-row items-center gap-2 rounded-dialog bg-surface-muted pl-4">
              <Input
                accessibilityLabel="Answer"
                value={draft}
                onChangeText={setDraft}
                multiline
                editable={!sending}
                className="max-h-32 flex-1 py-3"
              />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Send"
                accessibilityState={{ disabled: !draft.trim() || sending }}
                disabled={!draft.trim() || sending}
                onPress={() => void send(draft)}
                className="h-12 w-12 items-center justify-center"
              >
                <Host matchContents><Icon name={SEND_ICON} size={22} color={draft.trim() ? accent : muted} /></Host>
              </Pressable>
            </View>
          ) : null}
          {error ? <Text variant="error">{error}</Text> : null}
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}
