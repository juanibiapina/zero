import { useCallback, useEffect, useState } from "react";
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { messageOf, toast, type ShoppingItem, type TaskdoReplica } from "@zero/agent-core";
import { ChecklistRow } from "@/components/checklist-row";
import { ErrorText } from "@/components/ConnectionStatus";
import { TodoComposer } from "@/components/todo-composer";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet } from "@/components/ui/sheet";
import { useTodoData } from "@/lib/todo-data";

export function ShoppingPage() {
  const { replica } = useTodoData();
  return <div className="min-h-screen bg-background"><main className="container mx-auto px-4 py-6 sm:px-6 sm:py-8 lg:px-8 lg:py-10">
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6"><h1 className="text-2xl font-bold tracking-tight">Shopping list</h1>
      {replica ? <ShoppingList replica={replica} /> : <div className="min-h-24" />}
    </div>
  </main></div>;
}

function ShoppingList({ replica }: { replica: TaskdoReplica }) {
  const [items, setItems] = useState(() => replica.snapshot().shopping);
  useEffect(() => replica.subscribe((snapshot) => setItems(snapshot.shopping)), [replica]);
  const [error, setError] = useState<string | null>(null);
  const fail = useCallback((cause: unknown) => setError(messageOf(cause)), []);
  const shopping = replica.shopping;
  const sensors = useSensors(useSensor(PointerSensor), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));

  const buy = useCallback((item: ShoppingItem) => {
    setError(null);
    shopping.buy(item.id).then(
      () => toast("Bought", { id: "undo", action: { label: "Undo", onPress: () => { shopping.unbuy(item.id).catch(fail); } } }),
      fail,
    );
  }, [shopping, fail]);

  const onDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const toIndex = items.findIndex((item) => item.id === over.id);
    if (toIndex < 0) return;
    setError(null);
    shopping.move(String(active.id), toIndex).catch(fail);
  }, [items, shopping, fail]);

  const [editing, setEditing] = useState<ShoppingItem | null>(null);
  const [draft, setDraft] = useState("");
  const open = (item: ShoppingItem) => { setDraft(item.text); setEditing(item); };
  const commit = (): ShoppingItem | null => {
    if (!editing) return null;
    const text = draft.trim();
    if (!text) { setError("Write something to buy"); return null; }
    setError(null);
    if (text !== editing.text) shopping.edit(editing.id, text).catch(fail);
    return editing;
  };
  const close = () => { if (commit()) setEditing(null); };
  const buyEditing = () => {
    const item = commit();
    if (!item) return;
    setEditing(null);
    buy(item);
  };

  return <div className="flex flex-col gap-6">
    <TodoComposer replica={replica} initialKind="shopping" kinds={["shopping"]} />
    {error ? <ErrorText>{error}</ErrorText> : null}
    {items.length ? <section aria-label="Shopping list">
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={items.map((item) => item.id)} strategy={verticalListSortingStrategy}>
          <ul className="flex flex-col gap-3">{items.map((item) => <ChecklistRow key={item.id} id={item.id} text={item.text}
            checkLabel={`Mark "${item.text}" bought`} onCheck={() => buy(item)} onOpen={() => open(item)} />)}</ul>
        </SortableContext>
      </DndContext>
    </section> : null}
    <Sheet open={editing != null} onClose={close} title="Edit shopping item" srOnlyTitle>
      {editing ? <form className="flex flex-col gap-4" onSubmit={(event) => { event.preventDefault(); close(); }}>
        <div className="flex items-center gap-3">
          <Button type="button" variant="outline" size="icon" aria-label="Mark bought" onClick={buyEditing}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><circle cx="12" cy="12" r="9" /></svg>
          </Button>
          <Input autoFocus aria-label="Item text" value={draft} onChange={(event) => setDraft(event.target.value)} />
        </div>
      </form> : null}
    </Sheet>
  </div>;
}

