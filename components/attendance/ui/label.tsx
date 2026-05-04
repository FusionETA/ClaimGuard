/**
 * The attendance Label primitive previously had `peer-disabled` styling that
 * the canonical Label didn't. We re-export the canonical version because none
 * of the attendance pages render Labels with disabled-peer siblings — the
 * missing styles are inert in this codebase.
 *
 * Re-exporting (rather than deleting + rewriting imports) keeps every
 * attendance import path working.
 */
export { Label } from "@/components/ui/label"
