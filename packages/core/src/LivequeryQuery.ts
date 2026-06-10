// Inlined from @livequery/types so core owns the query/filter type machinery.

import type { LivequeryBaseEntity } from './LivequeryBaseEntity.js'

export type FlatObjectKeys<T, MatchType, K extends keyof T = keyof T> = (K extends string ? (T[K] extends MatchType ? K : (T[K] extends {
    [key: string]: any;
} ? (`${K}.${FlatObjectKeys<T[K], MatchType>}`) : never)) : never)

export type ChainObjectKeys<T, MatchType, Delimiter extends string = ','> = (T extends {
    [key: string]: any;
} ? (FlatObjectKeys<T, MatchType> | `${FlatObjectKeys<T, MatchType>}${Delimiter}${FlatObjectKeys<T, MatchType>}` | `${FlatObjectKeys<T, MatchType>}${Delimiter}${FlatObjectKeys<T, MatchType>}${Delimiter}${FlatObjectKeys<T, MatchType>}`) : never)

export type RequestMethod = 'put' | 'patch' | 'delete' | 'post'

export type ConditionTypeBuilder<T, FieldType, MapWith extends string, ResultType = any> = {
    [K in keyof T as `${FlatObjectKeys<T, FieldType>}:${MapWith}`]: ResultType;
}

export type Eq<T> = ConditionTypeBuilder<T, string | number | boolean, 'eq'> & {
    [Key in keyof T as (T[Key] extends string | number | boolean ? Key : never)]: T[Key];
}

export type Neq<T> = ConditionTypeBuilder<T, string | number | boolean, 'ne'>
export type NumberNotEqual<T> = ConditionTypeBuilder<T, number, 'nne'>
export type Lt<T> = ConditionTypeBuilder<T, number, 'lt', number>
export type Eqn<T> = ConditionTypeBuilder<T, number, 'eqn', number>
export type Lte<T> = ConditionTypeBuilder<T, number, 'lte', number>
export type Gt<T> = ConditionTypeBuilder<T, number, 'gt', number>
export type Gte<T> = ConditionTypeBuilder<T, number, 'gte', number>
export type Visible<T> = ConditionTypeBuilder<T, any, 'select', 0 | 1>
export type InArray<T> = ConditionTypeBuilder<T, number | string, 'in', Array<number | string>>
export type NotInArray<T> = ConditionTypeBuilder<T, number | string, 'nin', Array<number | string>>
export type Like<T> = ConditionTypeBuilder<T, string, 'like', string>
export type OrderBy<T> = ConditionTypeBuilder<T, number, 'order', 'asc' | 'desc'>

export type FilterConditions<T> = Partial<(Eq<T> & NumberNotEqual<T> & Neq<T> & Lt<T> & Eqn<T> & Lte<T> & Gt<T> & Gte<T> & Visible<T> & InArray<T> & NotInArray<T> & Like<T> & OrderBy<T> & {
    ':and': FilterConditions<T>;
    ':or': FilterConditions<T>;
    ':not': FilterConditions<T>;
})>

export type SummaryOperator<T> = 'count()' | `${'sum' | 'avg' | 'max' | 'min'}(${string})`
export type GroupByOperator<T> = '' | `|${FlatObjectKeys<T, string | number>}`

export type SummaryQuery<T> = {
    [key: `::${string}`]: `${SummaryOperator<T>}${GroupByOperator<T>}${GroupByOperator<T>}`;
}

export type BasicOptions = Partial<{
    ':limit': number;
    ':before': string;
    ':after': string;
    ':search': string;
    ':page': number;
    ':around': string;
}>

export type QueryOption<T extends LivequeryBaseEntity = LivequeryBaseEntity> = (BasicOptions & SummaryQuery<T> & FilterConditions<T>)
