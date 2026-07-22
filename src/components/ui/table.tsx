import * as React from "react";

import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";

const Table = React.forwardRef<HTMLTableElement, React.HTMLAttributes<HTMLTableElement>>(
  ({ className, ...props }, ref) => (
    <div
      className={cn(
        "relative w-full overflow-x-auto overflow-y-hidden",
        // Themed, slim horizontal scrollbar so wide tables scroll cleanly on small screens
        "[&::-webkit-scrollbar]:h-1.5 [&::-webkit-scrollbar-track]:bg-transparent",
        "[&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border/70 hover:[&::-webkit-scrollbar-thumb]:bg-border",
      )}
    >
      <table
        ref={ref}
        className={cn("w-full caption-bottom text-sm tabular-nums", className)}
        {...props}
      />
    </div>
  ),
);
Table.displayName = "Table";

const TableHeader = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <thead
    ref={ref}
    className={cn(
      // Subtle header zone; sticky variants (e.g. `sticky top-0`) inherit this background cleanly
      "bg-muted/40 [&_tr]:border-b",
      className,
    )}
    {...props}
  />
));
TableHeader.displayName = "TableHeader";

const TableBody = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <tbody ref={ref} className={cn("[&_tr:last-child]:border-0", className)} {...props} />
));
TableBody.displayName = "TableBody";

const TableFooter = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <tfoot
    ref={ref}
    className={cn("border-t bg-muted/50 font-medium [&>tr]:last:border-b-0", className)}
    {...props}
  />
));
TableFooter.displayName = "TableFooter";

const TableRow = React.forwardRef<HTMLTableRowElement, React.HTMLAttributes<HTMLTableRowElement>>(
  ({ className, ...props }, ref) => (
    <tr
      ref={ref}
      className={cn(
        "border-b border-border/60 transition-colors duration-150",
        "hover:bg-muted/60",
        "data-[state=selected]:bg-primary/10 data-[state=selected]:hover:bg-primary/15",
        className,
      )}
      {...props}
    />
  ),
);
TableRow.displayName = "TableRow";

const TableHead = React.forwardRef<
  HTMLTableCellElement,
  React.ThHTMLAttributes<HTMLTableCellElement>
>(({ className, ...props }, ref) => (
  <th
    ref={ref}
    className={cn(
      "h-11 px-3 text-left align-middle whitespace-nowrap text-xs font-semibold tracking-wide text-muted-foreground",
      "[&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]",
      className,
    )}
    {...props}
  />
));
TableHead.displayName = "TableHead";

const TableCell = React.forwardRef<
  HTMLTableCellElement,
  React.TdHTMLAttributes<HTMLTableCellElement>
>(({ className, ...props }, ref) => (
  <td
    ref={ref}
    className={cn(
      "px-3 py-2.5 align-middle [&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]",
      className,
    )}
    {...props}
  />
));
TableCell.displayName = "TableCell";

const TableCaption = React.forwardRef<
  HTMLTableCaptionElement,
  React.HTMLAttributes<HTMLTableCaptionElement>
>(({ className, ...props }, ref) => (
  <caption ref={ref} className={cn("mt-4 text-sm text-muted-foreground", className)} {...props} />
));
TableCaption.displayName = "TableCaption";

/**
 * Reusable empty-state row — spans the full table width with centered messaging.
 * Usage: <TableBody><TableEmpty colSpan={6} icon={<Inbox …/>}>No results</TableEmpty></TableBody>
 */
const TableEmpty = React.forwardRef<
  HTMLTableRowElement,
  React.HTMLAttributes<HTMLTableRowElement> & { colSpan: number; icon?: React.ReactNode }
>(({ className, colSpan, icon, children, ...props }, ref) => (
  <tr ref={ref} className={cn("hover:bg-transparent", className)} {...props}>
    <td colSpan={colSpan} className="px-4 py-12 text-center align-middle">
      <div className="flex flex-col items-center justify-center gap-2 text-muted-foreground">
        {icon && <div className="opacity-60 [&_svg]:h-8 [&_svg]:w-8">{icon}</div>}
        <div className="text-sm">{children ?? "No data to display"}</div>
      </div>
    </td>
  </tr>
));
TableEmpty.displayName = "TableEmpty";

/**
 * Reusable loading skeleton rows for a table body.
 * Usage: <TableBody><TableLoading rows={5} columns={6} /></TableBody>
 */
function TableLoading({
  rows = 5,
  columns = 4,
  className,
}: {
  rows?: number;
  columns?: number;
  className?: string;
}) {
  return (
    <>
      {Array.from({ length: rows }).map((_, r) => (
        <tr key={r} className={cn("border-b border-border/60", className)}>
          {Array.from({ length: columns }).map((_, c) => (
            <td key={c} className="px-3 py-2.5 align-middle">
              <Skeleton className={cn("h-4", c === 0 ? "w-3/4" : "w-1/2")} />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}
TableLoading.displayName = "TableLoading";

export {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableCaption,
  TableEmpty,
  TableLoading,
};
