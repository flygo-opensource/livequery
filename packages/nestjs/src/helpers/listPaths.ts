const RequestMethodList = [
    'GET',
    'POST',
    'PUT',
    'DELETE',
    'PATCH',
    'ALL',
    'OPTIONS',
    'HEAD',
    'SEARCH'
]



export const listPaths = (controllers: any[]) => {
    return controllers.map(controller => {
        const actions = Object.getOwnPropertyNames(controller.prototype).filter(c => c != 'constructor')
        const prefixs = [Reflect.getMetadata('path', controller)].flat(2)
       
        const refs =  actions.map(action => {
            const method = Reflect.getMetadata('method', controller.prototype[action])
            if (method === undefined) return []
            const paths =  [Reflect.getMetadata('path', controller.prototype[action]) || ['']].flat(3)


            return prefixs.map(prefix => {
                return paths.map(p => ({
                    method: RequestMethodList[method],
                    path: `${prefix}/${p}`.split('/').filter(x => !!x.trim()).join('/')
                }))
            }).flat(3)

        }).flat(2) 

        return refs 
    }).flat(4)
}