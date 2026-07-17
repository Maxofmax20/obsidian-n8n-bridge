### Added
- Real MCP Server implementation with HTTP transport (Model Context Protocol)
- MCP Server settings: enable/disable, port, server name
- n8n and Claude Desktop can now connect directly to your vault via MCP

### Fixed
- Sync vault anime to MyAnimeList command (pushes notes with mal_id to MAL)

### How to use MCP Server
1. Enable **MCP Server** in n8n Bridge settings
2. Configure n8n MCP Client node to connect to `http://localhost:3001/mcp`
3. For Claude Desktop, add to config:
```json
{
  "mcpServers": {
    "obsidian-vault": {
      "command": "npx",
      "args": ["mcp-remote", "http://localhost:3001/mcp"]
    }
  }
}
```
4. Restart Obsidian and Claude Desktop