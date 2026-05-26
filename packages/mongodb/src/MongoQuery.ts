import type { LivequeryBaseEntity, LivequeryRequest, FilterConditions } from "./types.js"
import { Cursor } from "./Cursor.js"
import { ObjectId } from "bson";
import type { Collection } from "mongodb";

export class MongoQuery {

    static #is_operator(c: string): boolean {
        return ['+', '-', '*', '/', '(', ')', '~'].indexOf(c) !== -1;
    }

    static #get_precedence(op: string): number {
        if (op == '~') return 3
        if (op === '+' || op === '-') {
            return 1;
        } else if (op === '*' || op === '/') {
            return 2;
        }
        return 0;
    }

    static #infix_to_postfix(expression: string): string[] {
        let stack: string[] = [];
        let output: string[] = [];
        let current = '';

        for (let i = 0; i < expression.length; i++) {
            const token = expression[i];

            if (this.#is_operator(token)) { // Include `~` as a part of the operators for handling `~~`
                if (current) {
                    output.push(current);
                    current = '';
                }
                if (token === '(') {
                    stack.push(token);
                } else if (token === ')') {
                    while (stack.length > 0 && stack[stack.length - 1] !== '(') {
                        output.push(stack.pop()!);
                    }
                    stack.pop();  // remove '(' from the stack
                } else {
                    while (stack.length > 0 && this.#get_precedence(token) <= this.#get_precedence(stack[stack.length - 1])) {
                        output.push(stack.pop()!);
                    }
                    stack.push(token);
                }
            } else if (/\s/.test(token)) {
                continue; // Ignore spaces
            } else {
                current += token;
            }
        }
        if (current) {
            output.push(current);
        }
        while (stack.length > 0) {
            output.push(stack.pop()!);
        }
        return output;
    }

    static #postfix_to_mongodb(postfixExpression: string[]) {
        let stack: any[] = [];
        for (let token of postfixExpression) {
            if (!isNaN(Number(token))) {
                stack.push(Number(token));
            } else if (token.includes('~')) {
                let value = stack.pop();
                stack.push({ $round: [value, 0] });
            } else if (this.#is_operator(token)) {
                const right = stack.pop();
                const left = stack.pop();
                switch (token) {
                    case '+':
                        stack.push({ $add: [left, right] });
                        break;
                    case '-':
                        stack.push({ $subtract: [left, right] });
                        break;
                    case '*':
                        stack.push({ $multiply: [left, right] });
                        break;
                    case '/':
                        stack.push({ $divide: [left, right] });
                        break;
                }
            } else {
                stack.push(`$${token}`);
            }
        }
        return stack.pop();
    }

    static #parse_array(value: unknown) {
        if (Array.isArray(value)) return value
        if (typeof value != 'string') return []
        try {
            const parsed = JSON.parse(value)
            return Array.isArray(parsed) ? parsed : []
        } catch {
            return []
        }
    }

    static #parse_summary<T extends LivequeryBaseEntity>(req: LivequeryRequest<T>) {


        const parsed = Object
            .entries(req.options)
            .map(([key, v], index) => {
                if (!key.startsWith('::')) return []

                const exprs = `${v}`.split('|').filter(Boolean)

                const fns = exprs.map(l => {
                    const exp = l.split('(')[0]
                    if (!['sum', 'avg', 'max', 'min', 'count', 'distinct'].includes(exp)) return []
                    if (exp == 'count' || exp == 'distinct') return [{ key: exp, query: { $sum: 1 } }]
                    const infix = l.split('(')?.[1]?.split(')')?.[0]
                    if (!infix) return []
                    const key = `${exp}_${infix}`
                    const query: object = this.#postfix_to_mongodb(this.#infix_to_postfix(infix))
                    return [{ key, query: { [`$${exp}`]: query } }]
                }).flat(2)

                const groups = exprs.filter(g => g.match(/^[a-zA-Z_]+$/))
                const $match = exprs.map(exp => {
                    for (const { c, f } of [
                        { c: '==', f: 'eq' },
                        { c: '<>', f: 'ne' },
                        { c: '>=', f: 'gte' },
                        { c: '<=', f: 'lte' },
                        { c: '>', f: 'gt' },
                        { c: '<', f: 'lt' },
                        { c: '=', f: 'eq' },
                    ]) {
                        if (exp.includes(c)) {
                            const [a, b] = exp.split(c)
                            return { [a]: { [f]: isNaN(Number(b)) ? (c == '==' ? (b == 'true') : b) : Number(b) } }
                        }
                    }
                }).filter(Boolean)

                const is_distinc_count = `${v}`.includes('distinc')


                const simple = is_distinc_count ? key : (exprs.length == 1 ? fns[0].key : false)

                const pipelines = [
                    ...$match.length > 0 ? [{ $match }] : [],
                    {
                        $group: {
                            _id: groups.length == 0 ? null : groups.reduce((p, by) => {
                                return {
                                    ...p,
                                    [by]: `$${by}`
                                }
                            }, {}),
                            ...fns.reduce((p, { query, key }) => ({
                                ...p,
                                [key]: query
                            }), {})
                        }
                    },
                    ...is_distinc_count ? [
                        {
                            $count: key
                        }
                    ] : [
                        {
                            $project: {
                                ...groups.reduce((p, c) => ({
                                    ...p,
                                    [c]: `$_id.${c}`
                                }), {}),
                                ...fns.reduce((p, { key }) => ({
                                    ...p,
                                    [key]: 1
                                }), {}),
                                _id: 0
                            }
                        },
                        {
                            $limit: 50
                        }
                    ]
                ]

                return [{ key, pipelines, simple }]
            })
            .flat(1)

        const pipelines = parsed.reduce((p, { key, pipelines }) => ({
            ...p,
            [key]: pipelines
        }), {})


        const summary = parsed.length == 0 ? undefined : parsed.reduce((p, { key, simple }) => {
            return {
                ...p,
                [key]: simple ? { $arrayElemAt: [`$${key}.${simple}`, 0] } : `$${key}`
            }
        }, {})


        return {
            pipelines,
            summary
        }
    }

    static #parse_conditions<T extends LivequeryBaseEntity>(filters: FilterConditions<T>) {
        if (!filters) return []
        const {
            ':and': and,
            ':or': or,
            ':not': not,
            ...rest
        } = filters

        const $or = Object.entries(rest).filter(
            ([k]) => k.endsWith(':like')
        ).map(([k, v]) => {
            const key = k.split(':like')[0]
            const value = `${v}`
            return {
                [key]: { $regex: value }
            }
        })


        const $match = Object.entries(rest).reduce(
            (p, [k, value]) => {
                if (k.startsWith('::')) return p
                const [key, expression] = k.split(':')
                const map = {
                    eq: () => ({ $eq: value }),
                    lt: () => ({ $lt: !isNaN(Number(value)) ? Number(value) : 0 }),
                    lte: () => ({ $lte: !isNaN(Number(value)) ? Number(value) : 0 }),
                    gt: () => ({ $gt: !isNaN(Number(value)) ? Number(value) : 0 }),
                    gte: () => ({ $gte: !isNaN(Number(value)) ? Number(value) : 0 }),
                    ne: () => {
                        return { $ne: value }
                    },
                    in: () => ({ $in: this.#parse_array(value) }),
                    nin: () => ({ $nin: this.#parse_array(value) }),
                    'eq-number': () => ({ $eq: !isNaN(Number(value)) ? Number(value) : 0 }),
                    'neq-number': () => ({ $ne: !isNaN(Number(value)) ? Number(value) : 0 }),
                    'eq-boolean': () => ({ $eq: `${value}`.toLowerCase() == 'true' ? true : false }),
                    'neq-boolean': () => ({ $ne: `${value}`.toLowerCase() == 'false' ? false : true }),
                    'eq-null': () => ({ $eq: null }),
                    'neq-null': () => ({ $ne: null }),
                    'eq-oid': () => ({ $eq: ObjectId.isValid(value as string) ? new ObjectId(value as string) : value }),
                    'neq-oid': () => ({ $ne: ObjectId.isValid(value as string) ? new ObjectId(value as string) : value }),
                }
                const fn = map[expression || 'eq']
                if (!fn) return p
                return {
                    ...p,
                    [key]: {
                        ...p[key] || {},
                        ...fn()
                    }
                }
            },
            $or.length > 0 ? { $or } : {}
        )

        return [
            ...Object.keys($match).length > 0 ? [{ $match }] : [],
            ...and && Object.keys(and).length > 0 ? [{ $expr: { $and: this.#parse_conditions(and) } }] : [],
            ...or && Object.keys(and).length > 0 ? [{ $expr: { $or: this.#parse_conditions(or) } }] : [],
            ...not && Object.keys(and).length > 0 ? [{ $not: { $and: this.#parse_conditions(not) } }] : [],
        ]
    }

    static #build_search_query<T extends LivequeryBaseEntity>(req: LivequeryRequest<T>) {
        const search = req.options[":search"]
        return search ? [{ $match: { $text: { $search: `${search}` } } }] : []
    }

    static #get_limit<T extends LivequeryBaseEntity>(req: LivequeryRequest<T>) {
        const l = Number(req.options[':limit'])
        if (isNaN(l)) return 10
        if (l < 1) return 1
        if (l > 100) return 100
        return l
    }

    static #rename_id() {
        return [
            {
                $set: {
                    id: "$_id"
                }
            }
        ]
    }

    static #build_cursor_query<T extends LivequeryBaseEntity>($sort: { [key: string]: number }, req: LivequeryRequest<T>, reverse: boolean = false) {
        const limit = this.#get_limit(req)
        const after = req.options[':after']
        const before = req.options[':before']
        const around = req.options[':around']


        const pagination_token = around || before || after
        const cursor = pagination_token ? Cursor.parse(pagination_token) : (reverse ? null : {})

        if (!cursor) return [{ $limit: 1 }, { $match: { _id: 0 } }]

        const $or = Object.entries({ ...$sort, _id: $sort._id || -1 }).map(([key, order], index, arr) => {
            const desc = order == -1
            const value = cursor[key == '_id' ? 'id' : key]
            const type = typeof value
            if (type == 'string' || type == 'number') {
                const expr = `${desc ? (reverse ? '$gt' : '$lt') : (reverse ? '$lt' : '$gt')}${reverse || around ? 'e' : ''}`
                const prevs = arr.slice(0, index).reduce((p, [key]) => ({ ...p, [key]: cursor[key] }), {})
                const cpr = (key == 'id' || key == '_id') ? new ObjectId(value as string) : value
                return {
                    ...prevs,
                    [key]: { [expr]: cpr }
                }

            }
            return {}
        })

        const items_visible = around || (reverse ? before : after) || (!reverse && !pagination_token)


        return [
            {
                $match: { $or }
            },

            {
                $project: {
                    _id: 0
                }
            },
            {
                $group: {
                    _id: null,
                    ...items_visible ? {
                        items: {
                            [reverse ? '$bottomN' : '$topN']: {
                                n: limit,
                                sortBy: {},
                                output: "$$ROOT"
                            }
                        }
                    } : {},
                    count: {
                        $sum: 1
                    }
                }
            },
            {
                $project: {
                    items: items_visible ? 1 : [],
                    count: 1
                }
            }
        ]
    }

    static #build_cursor_paging<T extends LivequeryBaseEntity>($sort: { [key: string]: number }, req: LivequeryRequest<T>) {

        if (req.options[':after'] || req.options[':before'] || req.options[':around']) {
            // Is cursor request, get items only



        }

        const { pipelines, summary } = this.#parse_summary(req)
        const limit = this.#get_limit(req)



        return [
            {
                $facet: {
                    ...pipelines,
                    prev: this.#build_cursor_query($sort, req, true),
                    next: this.#build_cursor_query($sort, req),
                }
            },
            {
                $project: {
                    summary,
                    prev: {
                        $ifNull: [
                            { $arrayElemAt: ["$prev", 0] },
                            { items: [], count: 0 }
                        ]
                    },
                    next: {
                        $ifNull: [
                            { $arrayElemAt: ["$next", 0] },
                            { items: [], count: 0 }
                        ]
                    }
                }
            },
            {
                $project: {
                    summary: 1,
                    items: {
                        $concatArrays: ["$prev.items", "$next.items"]
                    },
                    has: {
                        prev: { $gt: ["$prev.count", 0] },
                        next: { $gt: ["$next.count", limit] }
                    },
                    count: {
                        prev: { $max: [{ $subtract: ["$prev.count", 0] }, 0] },
                        next: { $max: [{ $subtract: ["$next.count", limit] }, 0] }
                    }
                }
            }
        ]
    }

    static #build_offset_paging<T extends LivequeryBaseEntity>(req: LivequeryRequest<T>) {
        return []
    }

    static #build_query_filter<T extends LivequeryBaseEntity>(req: LivequeryRequest<T>) {
        const {
            ":after": after,
            ":before": before,
            ':around': around,
            ":limit": _limit,
            ":page": _page,
            ":search": search,
            ...rest
        } = req.options
        return this.#parse_conditions({ ...rest, ...req.keys })
    }

    static #get_sorter<T extends LivequeryBaseEntity>(req: LivequeryRequest<T>) {
        let default_sort = -1
        const $sort = Object.entries(req.options).reduce((p, [k, order]) => {
            if (!k.endsWith(':sort')) return p
            const by = k.split(':sort')[0]
            const key = by == 'id' ? '_id' : by

            if (key == '_id') {
                if (order == 'asc' || order == '1' || order == 1) {
                    default_sort = 1
                }
                return p
            }

            return {
                ...p,
                [key]: order == 'asc' ? 1 : -1
            }

        }, {} as { [key: string]: number })
        $sort['_id'] = default_sort
        return $sort
    }

    static async query<T extends LivequeryBaseEntity>(req: LivequeryRequest<T>, collection: Collection<T>) {

        if (!req.is_collection) {
            const aggregates = [
                {
                    $match: {
                        ...req.keys,
                        ...req.keys.id ? { id: undefined, _id: ObjectId.createFromHexString(req.keys.id) } : {}
                    }
                },
                ...this.#rename_id(),
                {
                    $project: {
                        _id: 0
                    }
                }
            ]

            const items = await collection.aggregate(aggregates).toArray() as T[]

            return {
                items,
                limit: 1,
                count: { next: 0, prev: 0 },
                has: { next: false, prev: false },
                summary: {}
            }
        }

        const is_cursor_paging = req.options[':after'] || req.options[':before'] || req.options[':around'] || !req.options['page']

        const $sort = this.#get_sorter(req)

        const pipelines = [
            { $sort },
            ... this.#build_query_filter(req),
            ... this.#build_search_query(req),
            ... this.#rename_id(),
            ...is_cursor_paging ? this.#build_cursor_paging($sort, req) : this.#build_offset_paging(req)
        ]

        const response = await collection.aggregate(pipelines).toArray() as any as Array<{
            summary
            items: T[],
            has: {
                next: boolean
                prev: boolean
            }
            count: {
                next: number,
                prev: number
            }
        }>



        return {
            ...response[0],
            limit: this.#get_limit(req)
        }

    }
}
