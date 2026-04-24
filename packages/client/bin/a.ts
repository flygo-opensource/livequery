import { from, groupBy, mergeMap } from "rxjs"



const a = [1,1,2,3,4,1,2,3]

from(a).pipe(
    groupBy(x => x),
    mergeMap($ => {

        console.log(`Group: ${$.key}`)
        return $.pipe(
            // timer 10s here
        )
    })
).subscribe()