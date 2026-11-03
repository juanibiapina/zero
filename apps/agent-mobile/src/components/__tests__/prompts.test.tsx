import { describe, expect, it, jest } from '@jest/globals';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PromptModel } from '@zero/agent-core';
import { Stack } from 'expo-router';
import { fireEvent, renderRouter, waitFor } from 'expo-router/testing-library';
import { View } from 'react-native';

import BrowseLayout from '@/app/(todo)/browse/_layout';
import BrowseScreen from '@/app/(todo)/browse/index';
import PromptPage from '@/app/(todo)/browse/prompt/[id]';
import PromptsPage from '@/app/(todo)/browse/prompts';
import { PromptButton } from '@/components/prompts';
import { TabBarContext } from '@/lib/tab-bar';
import { createInMemoryTodoData, InMemoryTodoDataProvider } from '@/testing/in-memory-todo-data';

jest.mock('@clerk/expo', () => ({
  useAuth: () => ({ getToken: async () => 'token', signOut: async () => {} }),
  useUser: () => ({ user: null }),
}));
jest.mock('expo-router/build/testing-library/mocks', () => ({}));
// The document renders in a WebView, which Jest cannot run. The stand-in shows
// the Markdown as text and lets a test pick a passage or remove a comment.
jest.mock('@/components/prompt-document', () => {
  const { createElement } = jest.requireActual<typeof import('react')>('react');
  const { Pressable, Text, View } = jest.requireActual<typeof import('react-native')>('react-native');
  type MockProps = {
    markdown: string;
    comments: { id: string; text: string }[];
    onPassage: (quote: string) => Promise<void>;
    onRemoveComment: (id: string) => Promise<void>;
  };
  return {
    __esModule: true,
    default: ({ markdown, comments, onPassage, onRemoveComment }: MockProps) => createElement(View, null,
      createElement(Text, null, markdown),
      createElement(Pressable, { accessibilityLabel: 'Passage', onPress: () => void onPassage('Two flights fit the trip.') }),
      ...comments.map((comment) => createElement(Pressable, {
        key: comment.id, accessibilityLabel: `Remove ${comment.text}`, onPress: () => void onRemoveComment(comment.id),
      }))),
  };
});
jest.mock('react-native-safe-area-context', () => jest.requireActual<typeof import('react-native-safe-area-context/jest/mock')>('react-native-safe-area-context/jest/mock').default);

const flight = { title: 'Which flight?', text: 'Two flights fit the trip. Which one should I book?', suggestions: ['The 9:40', 'The 14:05'] };

function Home() {
  return <View><PromptButton /></View>;
}

async function open(initialUrl: string, seed: (model: PromptModel) => void = (model) => { model.create('p1', flight); }) {
  const data = createInMemoryTodoData();
  const model = new PromptModel(data.replica!.store);
  seed(model);
  const setTabBarHidden = jest.fn<(hidden: boolean) => void>();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const result = await renderRouter({
    _layout: () => (
      <QueryClientProvider client={client}>
        <InMemoryTodoDataProvider data={data}>
          <TabBarContext value={setTabBarHidden}><Stack screenOptions={{ headerShown: false }} /></TabBarContext>
        </InMemoryTodoDataProvider>
      </QueryClientProvider>
    ),
    index: Home,
    'browse/_layout': BrowseLayout,
    'browse/index': BrowseScreen,
    'browse/prompts': PromptsPage,
    'browse/prompt/[id]': PromptPage,
  }, { initialUrl });
  return { screen: await result, result, model, setTabBarHidden };
}

describe('Prompts', () => {
  it('lists new and answered Prompts under Browse', async () => {
    const { screen, result } = await open('/browse', (model) => {
      model.create('p1', flight);
      model.create('p2', { title: 'Dinner?', text: 'Where should we eat?', suggestions: [] });
      model.answer('p2', 'The Thai place');
    });
    await fireEvent.press(screen.getByLabelText('Prompts'));
    expect(result.getPathname()).toBe('/browse/prompts');
    expect(screen.getByLabelText('New: Which flight?')).toBeTruthy();
    expect(screen.getByText('The Thai place')).toBeTruthy();

    await fireEvent.press(screen.getByLabelText('New: Which flight?'));
    expect(result.getPathname()).toBe('/browse/prompt/p1');
  });

  it('shows the Prompt full screen, marks it read, and takes a suggestion as the answer', async () => {
    const { screen, result, model, setTabBarHidden } = await open('/browse/prompt/p1?from=list');
    expect(screen.getByText(flight.text)).toBeTruthy();
    expect(setTabBarHidden).toHaveBeenLastCalledWith(true);
    await waitFor(() => expect(model.get('p1')?.seenAt).not.toBeNull());

    await fireEvent.press(screen.getByText('The 14:05'));

    await waitFor(() => expect(result.getPathname()).toBe('/browse/prompts'));
    expect(model.get('p1')?.answer?.text).toBe('The 14:05');
    expect(setTabBarHidden).toHaveBeenLastCalledWith(false);
  });

  it('takes an answer in the user\'s own words', async () => {
    const { screen, model } = await open('/browse/prompt/p1?from=list');
    expect(screen.getByLabelText('Send').props.accessibilityState).toMatchObject({ disabled: true });
    await fireEvent.changeText(screen.getByLabelText('Answer'), 'Neither, wait for prices to drop');
    await fireEvent.press(screen.getByLabelText('Send'));
    await waitFor(() => expect(model.get('p1')?.answer?.text).toBe('Neither, wait for prices to drop'));
  });

  it('keeps comments on passages, which go with the answer', async () => {
    const { screen, model } = await open('/browse/prompt/p1?from=list');
    expect(screen.getByText('Tap a passage or select words to comment on them.')).toBeTruthy();

    await fireEvent.press(screen.getByLabelText('Passage'));
    expect(screen.getByText('Comment on “Two flights fit the trip.”')).toBeTruthy();
    expect(screen.queryByText('The 9:40')).toBeNull();
    await fireEvent.changeText(screen.getByLabelText('Comment'), 'Is there a train?');
    await fireEvent.press(screen.getByLabelText('Add comment'));

    await waitFor(() => expect(model.get('p1')?.comments).toMatchObject([{ quote: 'Two flights fit the trip.', text: 'Is there a train?' }]));
    expect(screen.getByText('1 comment goes with your answer.')).toBeTruthy();
    await fireEvent.press(screen.getByText('The 9:40'));
    await waitFor(() => expect(model.get('p1')?.answer?.text).toBe('The 9:40'));
    expect(model.get('p1')?.comments).toHaveLength(1);
  });

  it('removes a comment, and cancels one before it is added', async () => {
    const { screen, model } = await open('/browse/prompt/p1?from=list', (model) => {
      model.create('p1', flight);
      model.comment('p1', 'c1', { quote: '', text: 'Too early' });
    });
    await fireEvent.press(screen.getByLabelText('Remove Too early'));
    await waitFor(() => expect(model.get('p1')?.comments).toEqual([]));

    await fireEvent.press(screen.getByLabelText('Passage'));
    await fireEvent.press(screen.getByLabelText('Cancel comment'));
    expect(screen.getByText('The 9:40')).toBeTruthy();
  });

  it('shows an answered Prompt with its answer and no way to answer again', async () => {
    const { screen } = await open('/browse/prompt/p1?from=list', (model) => {
      model.create('p1', flight);
      model.answer('p1', 'Book the cheaper one');
    });
    expect(screen.getByText('Book the cheaper one')).toBeTruthy();
    expect(screen.queryByLabelText('Answer')).toBeNull();
    expect(screen.getByText('The 9:40')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'The 9:40' }).props.accessibilityState).toMatchObject({ disabled: true });
  });

  it('goes back to Prompts when the Prompt was deleted', async () => {
    const { result } = await open('/browse/prompt/gone?from=list');
    await waitFor(() => expect(result.getPathname()).toBe('/browse/prompts'));
  });

  it('counts unanswered Prompts on Home and opens the oldest, then the list when none are left', async () => {
    const { screen, result, model } = await open('/', (model) => {
      model.create('old', flight);
    });
    model.create('new', { ...flight, title: 'Newer' });
    await fireEvent.press(await screen.findByLabelText('Prompts, 2 unanswered'));
    expect(result.getPathname()).toBe('/browse/prompt/old');

    await fireEvent.press(screen.getByText('The 9:40'));
    await waitFor(() => expect(result.getPathname()).toBe('/'));
    model.answer('new', 'The 9:40');
    await fireEvent.press(await screen.findByLabelText('Prompts'));
    expect(result.getPathname()).toBe('/browse/prompts');
  });
});
