export type MaybePromise<T> = T | Promise<T>;
export type ResolverOptrions<T> = {
    name: string;
    validate?: (data: T) => MaybePromise<boolean>;
    resolve: () => Promise<T>;
};
export declare class DeduplicateComposer {
    #private;
    constructor();
    get<T>(opts: ResolverOptrions<T>): Promise<T>;
    define<T>(opts: ResolverOptrions<T>): ResolverOptrions<T>;
}
//# sourceMappingURL=DeduplicateComposer.d.ts.map