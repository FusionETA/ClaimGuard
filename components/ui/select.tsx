"use client"

import * as React from "react"
import * as SelectPrimitive from "@radix-ui/react-select"
import { Check, ChevronDown, ChevronUp, Search } from "lucide-react"

import { cn } from "@/lib/utils"

const Select = SelectPrimitive.Root
const SelectGroup = SelectPrimitive.Group
const SelectValue = SelectPrimitive.Value

/**
 * Above this many options a dropdown renders a search box so the user can
 * type to filter instead of scrolling. Applied automatically by
 * `SelectContent` — override per-dropdown with the `searchable` prop.
 */
const SEARCHABLE_OPTION_THRESHOLD = 7

const SelectTrigger = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger>
>(({ className, children, ...props }, ref) => (
  <SelectPrimitive.Trigger
    ref={ref}
    className={cn(
      "flex h-12 w-full items-center justify-between gap-2 rounded-2xl border border-border/80 bg-card px-4 py-2 text-base text-foreground shadow-sm transition-colors",
      "data-[placeholder]:text-muted-foreground",
      "hover:border-primary/40",
      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 ring-offset-background",
      "disabled:cursor-not-allowed disabled:opacity-50",
      "data-[state=open]:border-primary/60 data-[state=open]:ring-2 data-[state=open]:ring-primary/30",
      "[&>span]:line-clamp-1 [&>span]:text-left",
      "sm:h-11 sm:text-sm",
      className
    )}
    {...props}
  >
    {children}
    <SelectPrimitive.Icon asChild>
      <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200 data-[state=open]:rotate-180" />
    </SelectPrimitive.Icon>
  </SelectPrimitive.Trigger>
))
SelectTrigger.displayName = SelectPrimitive.Trigger.displayName

const SelectScrollUpButton = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.ScrollUpButton>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.ScrollUpButton>
>(({ className, ...props }, ref) => (
  <SelectPrimitive.ScrollUpButton
    ref={ref}
    className={cn("flex cursor-default items-center justify-center py-1 text-muted-foreground", className)}
    {...props}
  >
    <ChevronUp className="h-4 w-4" />
  </SelectPrimitive.ScrollUpButton>
))
SelectScrollUpButton.displayName = SelectPrimitive.ScrollUpButton.displayName

const SelectScrollDownButton = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.ScrollDownButton>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.ScrollDownButton>
>(({ className, ...props }, ref) => (
  <SelectPrimitive.ScrollDownButton
    ref={ref}
    className={cn("flex cursor-default items-center justify-center py-1 text-muted-foreground", className)}
    {...props}
  >
    <ChevronDown className="h-4 w-4" />
  </SelectPrimitive.ScrollDownButton>
))
SelectScrollDownButton.displayName = SelectPrimitive.ScrollDownButton.displayName

/** Flatten a React node into plain text for case-insensitive filtering. */
function nodeToText(node: React.ReactNode): string {
  if (node == null || node === false || node === true) return ""
  if (typeof node === "string" || typeof node === "number") return String(node)
  if (Array.isArray(node)) return node.map(nodeToText).join("")
  if (React.isValidElement(node)) {
    return nodeToText((node.props as { children?: React.ReactNode }).children)
  }
  return ""
}

function isType(node: React.ReactElement, ...types: React.ElementType[]) {
  return types.some((type) => node.type === type)
}

/** Count the selectable options in a `SelectContent` subtree. */
function countOptions(children: React.ReactNode): number {
  let total = 0
  React.Children.forEach(children, (child) => {
    if (!React.isValidElement(child)) return
    if (isType(child, SelectItem, SelectPrimitive.Item)) {
      total += 1
      return
    }
    const nested = (child.props as { children?: React.ReactNode }).children
    if (nested !== undefined) total += countOptions(nested)
  })
  return total
}

/** Text a given option should be matched against. */
function optionText(node: React.ReactElement): string {
  const props = node.props as { children?: React.ReactNode; textValue?: string }
  return (props.textValue ?? nodeToText(props.children)).toLowerCase()
}

/**
 * Keep only the options matching `query`. Group labels and separators are
 * dropped while filtering — they'd otherwise leave empty section headers
 * hanging above filtered-out children.
 */
function filterOptions(children: React.ReactNode, query: string): React.ReactNode[] {
  const out: React.ReactNode[] = []
  React.Children.forEach(children, (child) => {
    if (!React.isValidElement(child)) return
    if (isType(child, SelectItem, SelectPrimitive.Item)) {
      if (optionText(child).includes(query)) out.push(child)
      return
    }
    if (isType(child, SelectLabel, SelectPrimitive.Label, SelectSeparator, SelectPrimitive.Separator)) {
      return
    }
    const nested = (child.props as { children?: React.ReactNode }).children
    if (nested === undefined) return
    const kept = filterOptions(nested, query)
    if (kept.length > 0) out.push(React.cloneElement(child, undefined, kept))
  })
  return out
}

/**
 * Keys the search box lets through to Radix so list navigation, selection
 * and dismissal keep working while the caret sits in the input. Everything
 * else is swallowed so Radix's typeahead doesn't steal the keystroke (and
 * with it, focus).
 */
const PASSTHROUGH_KEYS = new Set(["ArrowDown", "ArrowUp", "Enter", "Escape", "Tab"])

const SelectContent = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Content> & {
    /**
     * Force the search box on or off. Defaults to "on when the dropdown has
     * more than {@link SEARCHABLE_OPTION_THRESHOLD} options".
     */
    searchable?: boolean
    /** Placeholder for the search box. */
    searchPlaceholder?: string
  }
>(({ className, children, position = "popper", searchable, searchPlaceholder = "Search…", ...props }, ref) => {
  // Content is unmounted while the dropdown is closed, so the query resets
  // itself every time the menu reopens.
  const [query, setQuery] = React.useState("")
  const trimmedQuery = query.trim().toLowerCase()

  const optionCount = React.useMemo(() => countOptions(children), [children])
  const showSearch = searchable ?? optionCount > SEARCHABLE_OPTION_THRESHOLD

  const visibleChildren = React.useMemo(() => {
    if (!showSearch || !trimmedQuery) return children
    return filterOptions(children, trimmedQuery)
  }, [children, showSearch, trimmedQuery])

  const hasMatches = !showSearch || !trimmedQuery || (visibleChildren as React.ReactNode[]).length > 0

  // Radix's SelectPrimitive.Content re-asserts DOM focus onto a list item
  // every time the visible item set changes. As the query filters the list
  // that yanks the caret out of the search box after the very first
  // keystroke (you type one char, then the cursor vanishes). Once the
  // filtered list has re-rendered, put focus back on the search input —
  // but only while a query is active, and only if focus actually left it,
  // so arrow-key navigation (which doesn't change the query) is never
  // disturbed.
  const searchInputRef = React.useRef<HTMLInputElement>(null)
  React.useEffect(() => {
    if (!showSearch || !trimmedQuery) return
    const el = searchInputRef.current
    if (el && document.activeElement !== el) el.focus()
  }, [visibleChildren, showSearch, trimmedQuery])

  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        ref={ref}
        position={position}
        className={cn(
          // max-w constraint keeps the popover from overflowing the
          // viewport on mobile when a SelectItem holds a long string
          // (e.g. a full project address). Pair with the `break-words`
          // on SelectItem below so the long string wraps instead of
          // clipping.
          "relative z-50 min-w-[8rem] max-w-[calc(100vw-1.5rem)] overflow-hidden rounded-2xl border border-white/40 bg-card/95 p-1 text-foreground shadow-panel backdrop-blur-xl",
          "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
          "data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
          position === "popper" &&
            "data-[side=bottom]:translate-y-1 data-[side=left]:-translate-x-1 data-[side=right]:translate-x-1 data-[side=top]:-translate-y-1",
          className
        )}
        {...props}
      >
        {showSearch ? (
          <div className="border-b border-border/60 px-2 py-2">
            <div className="flex items-center gap-2 rounded-xl border border-border/70 bg-background px-2.5 py-1.5">
              <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <input
                ref={searchInputRef}
                autoFocus
                type="text"
                value={query}
                placeholder={searchPlaceholder}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (!PASSTHROUGH_KEYS.has(event.key)) event.stopPropagation()
                }}
                className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              />
            </div>
          </div>
        ) : null}
        <SelectScrollUpButton />
        <SelectPrimitive.Viewport
          className={cn(
            "p-1",
            position === "popper" &&
              "h-[var(--radix-select-trigger-height)] w-full min-w-[var(--radix-select-trigger-width)] max-h-[min(20rem,var(--radix-select-content-available-height))]"
          )}
        >
          {hasMatches ? (
            visibleChildren
          ) : (
            <div className="px-3 py-6 text-center text-sm text-muted-foreground">
              No matches
            </div>
          )}
        </SelectPrimitive.Viewport>
        <SelectScrollDownButton />
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  )
})
SelectContent.displayName = SelectPrimitive.Content.displayName

const SelectLabel = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Label>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Label>
>(({ className, ...props }, ref) => (
  <SelectPrimitive.Label
    ref={ref}
    className={cn("px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground", className)}
    {...props}
  />
))
SelectLabel.displayName = SelectPrimitive.Label.displayName

const SelectItem = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Item>
>(({ className, children, ...props }, ref) => (
  <SelectPrimitive.Item
    ref={ref}
    className={cn(
      // `break-words` lets a long option label wrap onto multiple
      // lines instead of pushing the popover past the viewport (see
      // the matching max-w constraint on SelectContent).
      "relative flex w-full cursor-pointer select-none items-start gap-2 rounded-xl py-2 pl-3 pr-8 text-sm text-foreground outline-none transition-colors break-words",
      "focus:bg-primary/10 focus:text-foreground",
      "data-[state=checked]:bg-primary/10 data-[state=checked]:font-semibold",
      "data-[disabled]:pointer-events-none data-[disabled]:opacity-40",
      className
    )}
    {...props}
  >
    <span className="absolute right-2 flex h-4 w-4 items-center justify-center">
      <SelectPrimitive.ItemIndicator>
        <Check className="h-4 w-4 text-primary" />
      </SelectPrimitive.ItemIndicator>
    </span>
    <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
  </SelectPrimitive.Item>
))
SelectItem.displayName = SelectPrimitive.Item.displayName

const SelectSeparator = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Separator>
>(({ className, ...props }, ref) => (
  <SelectPrimitive.Separator
    ref={ref}
    className={cn("-mx-1 my-1 h-px bg-border/60", className)}
    {...props}
  />
))
SelectSeparator.displayName = SelectPrimitive.Separator.displayName

export {
  Select,
  SelectGroup,
  SelectValue,
  SelectTrigger,
  SelectContent,
  SelectLabel,
  SelectItem,
  SelectSeparator,
  SelectScrollUpButton,
  SelectScrollDownButton,
}
