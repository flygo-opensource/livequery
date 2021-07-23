import { COLLECTION_REF_SLICE_INDEX } from "./const"



export const ControllerMetadata = {

    create_method_decorator: <T>() => {

        const key = Symbol()

        const decorator = (data: T) => Reflect.metadata(key, data)

        const get_metadata = (target: { new() }) => {

            const collection_path: string = Reflect.getMetadata('path', target) || ''
            const methods = Object.getOwnPropertyNames(target.prototype)

            return methods
                .filter(method => Reflect.hasMetadata(key, target.prototype, method))
                .map(method => {
                    const data = Reflect.getMetadata(key, target.prototype, method) as T
                    const path: string = Reflect.getMetadata('path', target.prototype[method]) || ''
                    const ref = [collection_path.split('/'), path.split('/')]
                        .flat(2)
                        .filter(x => x.length > 0)
                        .slice(COLLECTION_REF_SLICE_INDEX)
                        .join('/')
                        .replaceAll(':', '')
                    return { data, method, ref }
                })
        }

        return [decorator, get_metadata] as [typeof decorator, typeof get_metadata]
    }
}