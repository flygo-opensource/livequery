// Just what this package calls, so it builds without the native module installed. Apps get the
// real types from expo-sqlite itself; this file is not published.
declare module 'expo-sqlite' {
    export function openDatabaseAsync(databaseName: string): Promise<unknown>
}
