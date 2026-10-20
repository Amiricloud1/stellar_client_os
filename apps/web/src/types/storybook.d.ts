declare module "@storybook/react" {
  import type { ComponentProps, ComponentType, JSXElementConstructor, ReactElement } from "react";

  export interface Meta<TCmpOrArgs = unknown> {
    title?: string;
    component?: TCmpOrArgs extends ComponentType<any> ? TCmpOrArgs : ComponentType<any>;
    parameters?: Record<string, unknown>;
    argTypes?: Record<string, unknown>;
    args?: TCmpOrArgs extends JSXElementConstructor<any>
      ? Partial<ComponentProps<TCmpOrArgs>>
      : Partial<TCmpOrArgs>;
    tags?: string[];
  }

  export type StoryFn<TArgs = Record<string, unknown>> = (args: TArgs) => ReactElement;

  export interface StoryObj<TMetaOrCmpOrArgs = Record<string, unknown>> {
    name?: string;
    args?: TMetaOrCmpOrArgs extends JSXElementConstructor<any>
      ? Partial<ComponentProps<TMetaOrCmpOrArgs>>
      : Partial<TMetaOrCmpOrArgs>;
    parameters?: Record<string, unknown>;
    render?: (
      args: TMetaOrCmpOrArgs extends JSXElementConstructor<any>
        ? ComponentProps<TMetaOrCmpOrArgs>
        : TMetaOrCmpOrArgs
    ) => ReactElement;
  }
}
