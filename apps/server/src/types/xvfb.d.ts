declare module 'xvfb' {
  export interface XvfbOptions {
    displayNum?: number;
    reuse?: boolean;
    timeout?: number;
    xvfb_args?: string[];
  }

  export default class Xvfb {
    public readonly display?: number;
    public readonly _display?: number;

    public constructor(options?: XvfbOptions);

    public start(callback?: (error?: Error | null) => void): void;
    public stop(callback?: (error?: Error | null) => void): void;
  }
}

