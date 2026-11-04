import { Host, Icon } from '@expo/ui';
import { messageOf, type Prompt } from '@zero/agent-core';
import { router, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { BackHandler, Linking, Pressable, ScrollView, SectionList, useColorScheme, View, type ScrollViewInstance } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { BackRow } from '@/components/back-row';
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
const QUESTION_ICON = Icon.select({ ios: 'questionmark', android: import('@expo/material-symbols/question_mark.xml') });
const CHECK_ICON = Icon.select({ ios: 'checkmark', android: import('@expo/material-symbols/check.xml') });
const DOWN_ICON = Icon.select({ ios: 'chevron.down', android: import('@expo/material-symbols/keyboard_arrow_down.xml') });

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

function arrivedAt(createdAt: string, now = Date.now()): string {
  const minutes = Math.floor((now - Date.parse(createdAt)) / 60_000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' }).format(new Date(createdAt));
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

function PromptState({ prompt }: { prompt: Prompt }) {
  const accent = useColor('--color-accent');
  const onAccent = useColor('--color-on-accent');
  const secondary = useColor('--color-foreground-secondary');
  if (prompt.answer) {
    return (
      <View className="h-[22px] w-[22px] items-center justify-center rounded-full bg-surface-muted">
        <Host matchContents><Icon name={CHECK_ICON} size={14} color={secondary} /></Host>
      </View>
    );
  }
  const unseen = !prompt.seenAt;
  return (
    <View className={unseen
      ? 'h-[22px] w-[22px] items-center justify-center rounded-full bg-accent'
      : 'h-[22px] w-[22px] items-center justify-center rounded-full bg-accent-soft'}
    >
      <Host matchContents><Icon name={QUESTION_ICON} size={14} color={unseen ? onAccent : accent} /></Host>
    </View>
  );
}

function PromptRow({ prompt }: { prompt: Prompt }) {
  const answer = prompt.answer?.text ?? null;
  const unseen = answer === null && !prompt.seenAt;
  return (
    <ListRow
      leading={<PromptState prompt={prompt} />}
      accessibilityLabel={unseen ? `New: ${prompt.title}` : prompt.title}
      onPress={() => openPrompt(prompt.id, 'list')}
      className="min-h-12"
    >
      <Text numberOfLines={1} className={unseen ? 'font-semibold' : answer !== null ? 'text-foreground-secondary' : undefined}>
        {prompt.title}
      </Text>
      <Text variant="subtitle" numberOfLines={1}>{answer ?? arrivedAt(prompt.createdAt)}</Text>
    </ListRow>
  );
}

export function PromptsScreen() {
  const { prompts } = usePrompts();
  const sections = [
    { title: 'Open', data: (prompts ?? []).filter((prompt) => !prompt.answer) },
    { title: 'Answered', data: (prompts ?? []).filter((prompt) => prompt.answer) },
  ].filter((section) => section.data.length > 0);
  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title="Prompts" back={{ label: 'Browse', accessibilityLabel: 'Back to Browse', onPress: backToBrowse }} />
      {prompts === null ? null : prompts.length === 0 ? (
        <Text variant="subtitle" className="px-screen-x py-6">No prompts yet.</Text>
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={(prompt) => prompt.id}
          renderItem={({ item }) => <PromptRow prompt={item} />}
          renderSectionHeader={({ section }) => (
            <View className="bg-background px-screen-x pb-1 pt-5">
              <Text variant="section">{section.title}</Text>
            </View>
          )}
          stickySectionHeadersEnabled={false}
        />
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
  const onAccent = useColor('--color-on-accent');
  const ripple = useColor('--color-ripple');
  const colors = {
    background: useColor('--color-background'),
    foreground: useColor('--color-foreground'),
    secondary: useColor('--color-foreground-secondary'),
    muted,
    surface: useColor('--color-surface-muted'),
    divider: useColor('--color-divider'),
    accent,
    accentSoft: useColor('--color-accent-soft'),
    onAccent,
    danger: useColor('--color-danger'),
  };
  const dark = useColorScheme() === 'dark';
  const [draft, setDraft] = useState('');
  const [passage, setPassage] = useState<string | null>(null);
  const [comment, setComment] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const scroll = useRef<ScrollViewInstance>(null);
  const answerFocused = useRef(false);
  const [viewport, setViewport] = useState(0);
  const [scrollY, setScrollY] = useState(0);
  const [answerTop, setAnswerTop] = useState(0);
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

  const addComment = async () => {
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
  };

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
  const answering = answered === null && passage === null;
  const answerBelow = answering && answerTop > 0 && viewport > 0 && answerTop > scrollY + viewport - 48;

  return (
    <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
      <View className="flex-1 bg-background">
        <BackRow
          {...(from === 'home'
            ? { label: 'Home', accessibilityLabel: 'Back to Home', onPress: close }
            : { label: 'Prompts', accessibilityLabel: 'Back to Prompts', onPress: close })}
        />
        <ScrollView
          ref={scroll}
          className="flex-1"
          keyboardShouldPersistTaps="handled"
          scrollEventThrottle={32}
          onScroll={(event) => setScrollY(event.nativeEvent.contentOffset.y)}
          onLayout={(event) => {
            setViewport(event.nativeEvent.layout.height);
            if (answerFocused.current) requestAnimationFrame(() => scroll.current?.scrollToEnd({ animated: true }));
          }}
          contentContainerStyle={{ paddingBottom: passage === null ? insets.bottom + 24 : 16 }}
        >
          <View className="mb-2 min-h-12 justify-center px-screen-x">
            <Text variant="title">{prompt.title}</Text>
          </View>
          {answered !== null ? (
            <View className="mx-screen-x mb-4 flex-row items-start gap-3 rounded-2xl bg-accent-soft px-4 py-3">
              <Host matchContents><Icon name={CHECK_ICON} size={20} color={accent} /></Host>
              <Text className="flex-1 font-semibold">{answered}</Text>
            </View>
          ) : null}
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
            dom={{ matchContents: true, scrollEnabled: false, containerStyle: { width: '100%' } }}
          />
          {answering ? (
            <View onLayout={(event) => setAnswerTop(event.nativeEvent.layout.y)} className="gap-2 px-screen-x pt-4">
              {commentCount > 0 ? (
                <Text variant="caption" className="pb-1">
                  {`${commentCount} ${commentCount === 1 ? 'comment goes' : 'comments go'} with your answer.`}
                </Text>
              ) : null}
              {prompt.suggestions.map((suggestion) => (
                <View key={suggestion} className="overflow-hidden rounded-2xl">
                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ disabled: sending }}
                    disabled={sending}
                    onPress={() => void send(suggestion)}
                    android_ripple={{ color: ripple }}
                    className="min-h-[52px] justify-center bg-accent-soft px-4 py-3"
                  >
                    <Text className="font-semibold">{suggestion}</Text>
                  </Pressable>
                </View>
              ))}
              <View className="min-h-[52px] flex-row items-center gap-2 rounded-2xl bg-surface-muted pl-4">
                <Input
                  accessibilityLabel="Answer"
                  placeholder="Your answer"
                  value={draft}
                  onChangeText={setDraft}
                  onFocus={() => { answerFocused.current = true; }}
                  onBlur={() => { answerFocused.current = false; }}
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
              {error ? <Text variant="error">{error}</Text> : null}
            </View>
          ) : null}
        </ScrollView>
        {answerBelow ? (
          <View pointerEvents="box-none" className="absolute inset-x-0 items-center" style={{ bottom: insets.bottom + 16 }}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Go to answer"
              onPress={() => scroll.current?.scrollToEnd({ animated: true })}
              className="h-11 flex-row items-center gap-1 rounded-full bg-accent pl-5 pr-3 shadow-raised"
            >
              <Text className="font-semibold text-on-accent">Answer</Text>
              <Host matchContents><Icon name={DOWN_ICON} size={22} color={onAccent} /></Host>
            </Pressable>
          </View>
        ) : null}
        {passage !== null ? (
          <View className="gap-2 border-t border-divider px-screen-x pt-3" style={{ paddingBottom: insets.bottom + 12 }}>
            <View className="flex-row items-center gap-3">
              <View className="w-[3px] self-stretch rounded-full bg-accent" />
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
            <View className="min-h-[52px] flex-row items-center gap-2 rounded-2xl bg-surface-muted pl-4">
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
        ) : null}
      </View>
    </KeyboardAvoidingView>
  );
}
