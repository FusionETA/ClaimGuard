import { Construction } from "lucide-react"

import { Card, CardContent } from "@/components/ui/card"

/**
 * Shared placeholder card for unfinished features. Used by both the employee
 * and admin Leave pages, and the Leave settings tab — keeps the wording in
 * sync without anyone having to touch three files.
 */
export function ComingSoonCard({
  title,
  body,
}: {
  title: string
  body: string
}) {
  return (
    <Card className="mx-auto max-w-2xl">
      <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-secondary text-secondary-foreground">
          <Construction className="h-6 w-6" />
        </div>
        <h2 className="font-headline text-xl font-bold text-foreground">{title}</h2>
        <p className="max-w-md text-sm text-muted-foreground">{body}</p>
      </CardContent>
    </Card>
  )
}
