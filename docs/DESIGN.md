# Design System Specification: The Architectural Claim

## 1. Overview & Creative North Star
**Creative North Star: "The Disciplined Workspace"**

This design system rejects the cluttered, line-heavy aesthetic of legacy enterprise software. Instead of relying on rigid grids and borders, we utilize **Tonal Architecture**. By using varying "weights" of surfaces rather than lines, we create an environment that feels both expansive and secure. 

The goal is to move beyond a "tool" and toward an "editorial dashboard." We achieve this through a signature use of **Manrope** for authoritative, wide-set headings and **Inter** for high-utility data density. The layout is intentionally asymmetrical; large headers anchored to the left provide a sense of stability, while floating glass components for secondary actions create a modern, lightweight feel suitable for a high-end PWA.

---

## 2. Colors & Surface Hierarchy
Our palette moves away from flat white. We use a sophisticated range of "cool greys" and "deep navies" to imply institutional trust.

### The "No-Line" Rule
**Borders are forbidden for sectioning.** To separate a sidebar from a main content area, or a table from a header, use a shift in background tokens (e.g., `surface` to `surface-container-low`). This creates a seamless, "molded" look.

### Surface Hierarchy & Nesting
Depth is achieved through the stacking of Material-based surface tokens:
*   **Base Layer:** `surface` (#f7f9fb) – The canvas for the entire application.
*   **Section Layer:** `surface-container` (#eceef0) – Used for grouping large functional areas.
*   **Card/Action Layer:** `surface-container-lowest` (#ffffff) – The "hero" surface for claims data, ensuring maximum contrast for readability.
*   **Interactive Layer:** `surface-bright` (#f7f9fb) – For elements that need to feel "lifted" or active.

### The "Glass & Gradient" Rule
To elevate the "Internal Tool" aesthetic, use **Glassmorphism** for floating elements like mobile bottom navs or desktop "Quick Action" menus. 
*   **Formula:** `surface_container_lowest` at 80% opacity + 12px Backdrop Blur.
*   **Signature Gradients:** Primary CTAs should not be flat. Use a subtle linear gradient: `primary` (#0a396c) to `primary_container` (#2a5084) at a 135-degree angle to add a "jewel-toned" depth.

---

## 3. Typography
We employ a dual-font strategy to balance corporate authority with functional clarity.

*   **Display & Headlines (Manrope):** Chosen for its modern, geometric structure. Use `display-lg` and `headline-md` for page titles and high-level claim summaries. These should be set with a slightly tighter letter-spacing (-0.02em) to look "bespoke."
*   **Body & Labels (Inter):** The workhorse for data. Inter’s high x-height ensures that `body-sm` (0.75rem) remains legible in dense claim tables.
*   **Hierarchy Note:** Use `on_surface_variant` (#434653) for secondary metadata to create a natural visual "recession," allowing primary claim IDs (in `on_surface`) to pop.

---

## 4. Elevation & Depth

### The Layering Principle
Do not use shadows to define a card. Place a `surface-container-lowest` (White) card on a `surface-container` (Light Grey) background. The 4-unit color shift is sufficient for the human eye to perceive a boundary without visual noise.

### Ambient Shadows
For floating modals or dropdowns, use "Ambient Shadows":
*   **Box-shadow:** `0px 12px 32px rgba(25, 28, 30, 0.06)`
*   **Tone:** Notice the shadow is not black; it uses a 6% opacity of `on_surface` (#191c1e) to ensure it looks like a natural shadow cast on a corporate surface.

### The "Ghost Border" Fallback
If a boundary is required for accessibility (e.g., a search input), use a **Ghost Border**: `outline-variant` (#c3c6d5) at 20% opacity. It should be felt, not seen.

---

## 5. Components

### Buttons
*   **Primary:** Gradient fill (`primary` to `primary_container`), `DEFAULT` (8px) radius. No border.
*   **Secondary:** `surface-container-high` fill with `on_surface` text. Feels integrated into the page.
*   **Tertiary:** Transparent background, `on_primary_fixed_variant` text. High-density environments only.

### Cards & Claims Lists
*   **Rule:** Forbid divider lines between list items.
*   **Execution:** Use 12px of vertical padding (`spacing-md`) and a subtle hover state shift to `surface-container-lowest`. 
*   **Nesting:** Place the status chip (e.g., "Approved") in the top right with a 12px (`lg`) corner radius to soften the technical nature of the data.

### Input Fields
*   **Style:** Minimalist. Use `surface-container-low` as the field background.
*   **States:** On focus, transition the background to `surface-container-lowest` and apply a 2px "Ghost Border" of `primary`.

### Status Chips (Functional Colors)
*   **Approved:** Container `primary_fixed` / Text `on_primary_fixed`.
*   **Pending:** Container `tertiary_fixed` / Text `tertiary_fixed_variant`.
*   **Rejected:** Container `error_container` / Text `on_error_container`.
*   **Paid:** Container `secondary_container` / Text `on_secondary_fixed`.

---

## 6. Do's and Don'ts

### Do
*   **Do** use white space as a structural element. If an interface feels crowded, increase the padding between containers rather than adding a line.
*   **Do** use `manrope` for any text larger than 1.5rem. It provides the "premium" feel that standard sans-serifs lack.
*   **Do** utilize the responsive "Surface Shift." On mobile, the `surface-container-lowest` should be used for the bottom navigation bar with a backdrop blur to keep the user grounded.

### Don't
*   **Don't** use 100% black (#000000) for text. Always use `on_surface` (#191c1e) to maintain the sophisticated tonal range.
*   **Don't** use the `full` (9999px) roundedness for buttons. Stick to `DEFAULT` (8px) or `md` (12px) to maintain a "professional corporate" rather than "playful consumer" vibe.
*   **Don't** use standard "drop shadows" on cards. Rely on tonal layering. If it looks flat, your background contrast (`surface` vs `surface-container`) is too low.