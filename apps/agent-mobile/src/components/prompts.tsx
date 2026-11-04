import { Host, Icon } from '@expo/ui';
import { messageOf, type Prompt } from '@zero/agent-core';
import { router, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { BackHandler, FlatList, Linking, Pressable, useColorScheme, View } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import PromptDocument from '@/components/prompt-document';
import { ScreenHeader } from '@/components/screen-header';
import { Input } from '@/components/ui/input';
import { ListRow } from '@/components/ui/list-row';
import { Text } from '@/components/ui/text';
import { usePrompts } from '@/lib/prompts';
import { useHiddenTabBar } from '@/lib/tab-bar';
import { useColor } from '@/lib/theme';

const PROMPT_ICON = Icon.select({ ios: 'questionmark.bubble', android: import('@expo/material-symbols/live_help.xml') });
const SEND_ICON = Icon.select({ ios: 'paperplane.fill', android: import('@expo/material-symbols/send.xml') });
const CLOSE_ICON = Icon.select({ ios: 'xmark', android: import('@expo/material-symbols/close.xml') });

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
  const colors = {
    background: useColor('--color-background'),
    foreground: useColor('--color-foreground'),
    secondary: useColor('--color-foreground-secondary'),
    muted,
    surface: useColor('--color-surface-muted'),
    divider: useColor('--color-divider'),
    accent,
    onAccent: useColor('--color-on-accent'),
  };
  const dark = useColorScheme() === 'dark';
  const [draft, setDraft] = useState('');
  const [passage, setPassage] = useState<string | null>(null);
  const [comment, setComment] = useState('');
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

  const addComment = useCallback(async () => {
    if (!replica || passage === null || sending || !comment.trim()) return;
    setSending(true);
    setError(null);
    try {
      await replica.prompts.comment(id, { quote: passage, text: comment });
      setPassage(null);
      setComment('');
    } catch (cause) {
      setError(messageOf(cause));
    }
    setSending(false);
  }, [replica, passage, sending, comment, id]);

  const removeComment = useCallback(async (commentId: string) => {
    if (!replica) return;
    setError(null);
    try {
      await replica.prompts.removeComment(id, commentId);
    } catch (cause) {
      setError(messageOf(cause));
    }
  }, [replica, id]);

  if (!prompt) return <View className="flex-1 bg-background" />;
  const answered = prompt.answer?.text ?? null;
  const commentCount = prompt.comments.length;

  return (
    <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
      <View className="flex-1 bg-background" style={{ paddingBottom: insets.bottom + 12 }}>
        <ScreenHeader
          title={prompt.title}
          back={from === 'home'
            ? { label: 'Home', accessibilityLabel: 'Back to Home', onPress: close }
            : { label: 'Prompts', accessibilityLabel: 'Back to Prompts', onPress: close }}
        />
        <View className="flex-1">
          <PromptDocument
            markdown={prompt.text}
            comments={prompt.comments.map(({ id: commentId, quote, text }) => ({ id: commentId, quote, text }))}
            pendingQuote={passage}
            canComment={answered === null}
            dark={dark}
            colors={colors}
            onPassage={async (quote) => { setPassage(quote); }}
            onRemoveComment={removeComment}
            onOpenLink={async (url) => { await Linking.openURL(url); }}
            dom={{ style: { flex: 1, backgroundColor: colors.background } }}
          />
        </View>
        {passage !== null ? (
          <View className="gap-2 px-screen-x pt-2">
            <View className="flex-row items-center gap-2">
              <Text variant="caption" numberOfLines={2} className="flex-1">Comment on “{passage}”</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Cancel comment"
                onPress={() => { setPassage(null); setComment(''); }}
                className="h-10 w-10 items-center justify-center"
              >
                <Host matchContents><Icon name={CLOSE_ICON} size={20} color={muted} /></Host>
              </Pressable>
            </View>
            <View className="min-h-14 flex-row items-center gap-2 rounded-dialog bg-surface-muted pl-4">
              <Input
                accessibilityLabel="Comment"
                value={comment}
                onChangeText={setComment}
                multiline
                autoFocus
                editable={!sending}
                className="max-h-32 flex-1 py-3"
              />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Add comment"
                accessibilityState={{ disabled: !comment.trim() || sending }}
                disabled={!comment.trim() || sending}
                onPress={() => void addComment()}
                className="h-12 w-12 items-center justify-center"
              >
                <Host matchContents><Icon name={SEND_ICON} size={22} color={comment.trim() ? accent : muted} /></Host>
              </Pressable>
            </View>
            {error ? <Text variant="error">{error}</Text> : null}
          </View>
        ) : (
        <View className="gap-2 px-screen-x pt-2">
          {answered === null ? (
            <Text variant="caption">
              {commentCount === 0
                ? 'Tap a passage or select words to comment on them.'
                : `${commentCount} ${commentCount === 1 ? 'comment goes' : 'comments go'} with your answer.`}
            </Text>
          ) : null}
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
        )}
      </View>
    </KeyboardAvoidingView>
  );
}
