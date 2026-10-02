export interface ToolConfig {
  root: string
  writeRoot?: string | null
  commands?: string[]
  deniedCommands?: string[]
  search?: boolean
  readDomains?: string[]
}
export interface ToolResult { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> }
export function toolDefinitions(config: ToolConfig): Array<{ name: string; description: string; inputSchema: object }>
export function createTools(config: ToolConfig): (name: string, args: Record<string, unknown>) => Promise<ToolResult>
