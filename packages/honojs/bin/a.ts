import {Hono} from 'hono'
import {matchedRoutes} from 'hono/route'


const app = new Hono()
app.get('/a/:b/c', c => {
    console.log(c.req)
    console.log(matchedRoutes(c))
    return c.text('Hello, Livequery!')
})
 
export default {
  port: 3000,
  fetch: app.fetch,
}