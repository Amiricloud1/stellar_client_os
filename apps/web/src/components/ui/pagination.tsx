import * as React from "react"
import { ChevronLeft, ChevronRight, MoreHorizontal } from "lucide-react"

import { cn } from "@/lib/utils"
import { ButtonProps, buttonVariants } from "@/components/ui/button"

const Pagination = ({ className, ...props }: React.ComponentProps<"nav">) => (
    <nav
        role="navigation"
        aria-label="pagination"
        className={cn("mx-auto flex w-full justify-center", className)}
        {...props}
    />
)
Pagination.displayName = "Pagination"

const PaginationContent = React.forwardRef<
    HTMLUListElement,
    React.ComponentProps<"ul">
>(({ className, ...props }, ref) => (
    <ul
        ref={ref}
        className={cn("flex flex-row items-center gap-1", className)}
        {...props}
    />
))
PaginationContent.displayName = "PaginationContent"

const PaginationItem = React.forwardRef<
    HTMLLIElement,
    React.ComponentProps<"li">
>(({ className, ...props }, ref) => (
    <li ref={ref} className={cn("", className)} {...props} />
))
PaginationItem.displayName = "PaginationItem"

export type PageInfo = {
    total: number
    page: number
    pageSize: number
    hasNext: boolean
    hasPrev: boolean
}

type PaginationLinkProps = {
    isActive?: boolean
    disabled?: boolean
} & Pick<ButtonProps, "size"> &
    React.ComponentProps<"a">

const PaginationLink = ({
    className,
    isActive,
    disabled,
    size = "icon",
    ...props
}: PaginationLinkProps) => (
    <a
        aria-current={isActive ? "page" : undefined}
        className={cn(
            buttonVariants({
                variant: isActive ? "outline" : "ghost",
                size,
            }),
            disabled && "pointer-events-none opacity-50",
            isActive && "border-zinc-600 bg-zinc-800",
            "cursor-pointer text-zinc-300",
            className
        )}
        {...props}
    />
)
PaginationLink.displayName = "PaginationLink"

const PaginationPrevious = ({
    className,
    disabled,
    ...props
}: React.ComponentProps<typeof PaginationLink>) => (
    <PaginationLink
        aria-label="Go to previous page"
        size="default"
        disabled={disabled}
        className={cn("gap-1 pl-2.5", className)}
        {...props}
    >
        <ChevronLeft className="h-4 w-4" />
        <span>Previous</span>
    </PaginationLink>
)
PaginationPrevious.displayName = "PaginationPrevious"

const PaginationNext = ({
    className,
    disabled,
    ...props
}: React.ComponentProps<typeof PaginationLink>) => (
    <PaginationLink
        aria-label="Go to next page"
        size="default"
        disabled={disabled}
        className={cn("gap-1 pr-2.5", className)}
        {...props}
    >
        <span>Next</span>
        <ChevronRight className="h-4 w-4" />
    </PaginationLink>
)
PaginationNext.displayName = "PaginationNext"

const PaginationSummary = ({
    className,
    pageInfo,
    ...props
}: Omit<React.ComponentProps<"p">, "children"> & {
    pageInfo: PageInfo
}) => {
    const { total, page, pageSize } = pageInfo
    const start = total === 0 ? 0 : (page - 1) * pageSize + 1
    const end = Math.min(page * pageSize, total)

    return (
        <p
            aria-live="polite"
            className={cn("text-sm text-zinc-400", className)}
            {...props}
        >
            {total === 0
                ? "No results"
                : `Showing ${start}\u2013${end} of ${total}`}
        </p>
    )
}
PaginationSummary.displayName = "PaginationSummary"

const PaginationEllipsis = ({
    className,
    ...props
}: React.ComponentProps<"span">) => (
    <span
        aria-hidden
        className={cn("flex h-9 w-9 items-center justify-center", className)}
        {...props}
    >
        <MoreHorizontal className="h-4 w-4 text-zinc-400" />
        <span className="sr-only">More pages</span>
    </span>
)
PaginationEllipsis.displayName = "PaginationEllipsis"

export {
    Pagination,
    PaginationContent,
    PaginationEllipsis,
    PaginationItem,
    PaginationLink,
    PaginationNext,
    PaginationPrevious,
    PaginationSummary,
}
