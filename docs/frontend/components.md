# Frontend Components

## Overview

The frontend of the web application is built with Next.js and styled using Tailwind CSS. It is configured to use the `shadcn/ui` component library, which allows for a flexible and composable approach to building the user interface.

## Configuration

The `components.json` file in the `apps/web` directory contains the configuration for `shadcn/ui`. Key settings include:

-   **Style**: `new-york`
-   **RSC (React Server Components)**: Enabled
-   **TSX**: Enabled
-   **CSS Variables**: Enabled
-   **Aliases**:
    -   `@/components`: For general-purpose components.
    -   `@/utils`: For utility functions.
    -   `@/ui`: For `shadcn/ui` components.
    -   `@/lib`: For library code.
    -   `@/hooks`: For custom React hooks.

## Core Components and Utilities

### `cn` Utility Function

Located in `src/lib/utils.ts`, the `cn` function is a helper that merges CSS classes. It combines the functionality of `clsx` (for conditional class names) and `tailwind-merge` (for resolving conflicting Tailwind CSS classes).

```typescript
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs));
}
```

### Main Page (`page.tsx`)

The main entry point of the application is the `page.tsx` file. Currently, this page serves as a placeholder and uses standard HTML elements along with the `next/image` component for image optimization. It does not yet implement any custom or `shadcn/ui` components.

### Custom Components

As of now, there are no custom components defined in the `src/components` directory. The structure is in place to add new components as the application develops. When adding new components from `shadcn/ui`, they will be located in the `src/components/ui` directory, following the aliasing convention.

## Standards and Guidelines

For in-depth guidelines on offline synchronization and conflict recovery, WCAG 2.2 AA accessibility audit patterns, performance budgets for discovery and maps, and centralized locale-aware formatting, see [Frontend Standards and Contributor Guide](./standards-and-guides.md).

