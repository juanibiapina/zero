import { EmojiPicker } from "frimousse";

export function EmojiGrid({ onPick }: { onPick: (emoji: string) => void }) {
  return (
    <EmojiPicker.Root
      className="isolate flex h-[368px] w-fit flex-col"
      onEmojiSelect={({ emoji }) => onPick(emoji)}
    >
      <EmojiPicker.Search
        autoFocus
        aria-label="Search emoji"
        placeholder="Search emoji…"
        className="z-10 mx-2 mt-2 mb-1 h-9 rounded-md border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
      />
      <EmojiPicker.Viewport className="relative flex-1 outline-hidden">
        <EmojiPicker.Loading className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
          Loading…
        </EmojiPicker.Loading>
        <EmojiPicker.Empty className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
          No emoji found.
        </EmojiPicker.Empty>
        <EmojiPicker.List
          className="select-none pb-1.5"
          components={{
            CategoryHeader: ({ category, ...props }) => (
              <div
                className="bg-popover px-3 pt-3 pb-1.5 text-xs font-medium text-muted-foreground"
                {...props}
              >
                {category.label}
              </div>
            ),
            Row: ({ children, ...props }) => (
              <div className="scroll-my-1.5 px-1.5" {...props}>
                {children}
              </div>
            ),
            Emoji: ({ emoji, ...props }) => (
              <button
                aria-label={`Set icon ${emoji.emoji}`}
                className="flex size-8 items-center justify-center rounded-md text-lg data-[active]:bg-accent"
                {...props}
              >
                {emoji.emoji}
              </button>
            ),
          }}
        />
      </EmojiPicker.Viewport>
    </EmojiPicker.Root>
  );
}

export function IconStrip({ icons, chosen, onPick }: { icons: string[]; chosen: string; onPick: (emoji: string) => void }) {
  return (
    <div role="group" aria-label="Suggested icons" className="flex h-9 items-center gap-0.5 overflow-hidden">
      {icons.map((emoji) => (
        <button key={emoji} type="button" aria-label={`Use icon ${emoji}`} aria-pressed={emoji === chosen}
          onClick={() => onPick(emoji)}
          className={`flex size-8 shrink-0 items-center justify-center rounded-md text-lg hover:bg-accent ${emoji === chosen ? "bg-accent ring-1 ring-ring" : ""}`}>
          {emoji}
        </button>
      ))}
    </div>
  );
}
