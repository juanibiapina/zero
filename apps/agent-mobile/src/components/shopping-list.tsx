import { messageOf, toast, type ShoppingItem, type TaskdoReplica } from '@zero/agent-core';
import { router } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { BackHandler, View } from 'react-native';

import { useQuickAdd } from '@/components/quick-add-composer';
import { ChecklistRow, ReorderableChecklist } from '@/components/reorderable-checklist';
import { ScreenHeader } from '@/components/screen-header';
import { TaskEditorSheet } from '@/components/task-editor-sheet';
import { CheckCircle } from '@/components/ui/list-row';
import { Text } from '@/components/ui/text';
import { usePullRefresh } from '@/lib/screen-hooks';
import { useShoppingList } from '@/lib/shopping-list';

const BACK_TO_BROWSE = { label: 'Browse', accessibilityLabel: 'Back to Browse', onPress: () => router.dismissTo('/browse') };

export function ShoppingListScreen() {
  const { replica, items } = useShoppingList();
  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title="Shopping list" back={BACK_TO_BROWSE} />
      {replica && items ? <ShoppingList replica={replica} items={items} /> : <View className="flex-1" />}
    </View>
  );
}

function ShoppingList({ replica, items }: { replica: TaskdoReplica; items: ShoppingItem[] }) {
  const shopping = replica.shopping;
  const [error, setError] = useState<string | null>(null);
  const fail = useCallback((cause: unknown) => setError(messageOf(cause)), []);
  const { refreshing, onRefresh } = usePullRefresh(replica.refresh);

  const add = useQuickAdd({ replica, surface: { kind: 'shopping-list' }, onError: setError });
  const handleAddBack = add.handleBack;
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', handleAddBack);
    return () => sub.remove();
  }, [handleAddBack]);

  const buy = useCallback((item: ShoppingItem) => {
    setError(null);
    shopping.buy(item.id).then(
      () => toast('Bought', { id: 'undo', action: { label: 'Undo', onPress: () => { shopping.unbuy(item.id).catch(fail); } } }),
      fail,
    );
  }, [shopping, fail]);

  const move = useCallback((item: ShoppingItem, toIndex: number) => {
    setError(null);
    shopping.move(item.id, toIndex).catch(fail);
  }, [shopping, fail]);

  const editor = useShoppingItemEditor({ replica, items, onBuy: buy, onError: setError });

  const renderItem = useCallback(
    (item: ShoppingItem) => (
      <ChecklistRow
        accessibilityLabel={`Edit "${item.text}"`}
        checkLabel={`Mark "${item.text}" bought`}
        onCheck={() => buy(item)}
        onPress={() => editor.open(item)}
      >
        <Text>{item.text}</Text>
      </ChecklistRow>
    ),
    [buy, editor],
  );

  return (
    <>
      {error ? <Text variant="error" selectable className="px-screen-x">{error}</Text> : null}
      <ReorderableChecklist
        items={items}
        renderItem={renderItem}
        onMove={move}
        refreshing={refreshing}
        onRefresh={onRefresh}
      />
      {editor.sheet}
      {add.element}
    </>
  );
}

// The Task edit sheet for a shopping item: the check circle and the text,
// saved when the sheet closes. Item text is literal, so no dates are parsed.
function useShoppingItemEditor({ replica, items, onBuy, onError }: {
  replica: TaskdoReplica;
  items: ShoppingItem[];
  onBuy: (item: ShoppingItem) => void;
  onError: (message: string | null) => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const selected = items.find((item) => item.id === selectedId) ?? null;

  const open = useCallback((item: ShoppingItem) => {
    setDraft(item.text);
    setSelectedId(item.id);
  }, []);

  const commit = useCallback((): ShoppingItem | null => {
    if (!selected) return null;
    const text = draft.trim();
    if (!text) {
      onError('Write something to buy');
      return null;
    }
    onError(null);
    if (text !== selected.text) replica.shopping.edit(selected.id, text).catch((cause: unknown) => onError(messageOf(cause)));
    return selected;
  }, [selected, draft, replica, onError]);

  const close = useCallback((): void | false => {
    if (selected && !commit()) return false;
    setSelectedId(null);
  }, [selected, commit]);

  const buySelected = useCallback(() => {
    const item = commit();
    if (!item) return;
    setSelectedId(null);
    onBuy(item);
  }, [commit, onBuy]);

  const sheet = (
    <TaskEditorSheet
      open={selected != null}
      onClose={close}
      draft={draft}
      onChangeDraft={setDraft}
      onSubmit={() => { close(); }}
      placeholder="Item"
      inputAccessibilityLabel="Item text"
      leading={<CheckCircle label="Mark bought" onPress={buySelected} />}
    />
  );

  return { open, sheet };
}
