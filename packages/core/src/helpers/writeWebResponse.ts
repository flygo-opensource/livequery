import { ServerResponse } from "http"

export async function writeWebResponse(res: ServerResponse, response: Response): Promise<void> {
    const headers: Record<string, string> = {}
    response.headers.forEach((value, key) => {
        headers[key] = value
    })
    res.writeHead(response.status, headers)
    res.end(Buffer.from(await response.arrayBuffer()))
} 
