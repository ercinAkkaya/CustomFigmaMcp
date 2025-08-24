🎨 Figma MCP - My First Custom MCP Project
Hey! This is my personal experiment with building a custom MCP (Model Context Protocol) server that connects Figma to AI assistants like Claude in Cursor. It's my first time creating an MCP, so bear with me - but it actually works pretty well for analyzing Figma design files!
What does this thing do?
Basically, I got tired of manually checking my Figma designs for consistency issues, so I built this tool that lets me ask Claude (through Cursor) questions about my designs in plain English.
🔍 Design File Analysis

Get a quick overview of your entire Figma file - pages, colors, styles, the whole thing
Dig into specific components or groups when you need details
Check if your design system is being used consistently (spoiler: it probably isn't)

🧩 UI Component Detective Work

Automatically finds buttons, cards, input fields, etc. in your designs
Counts how many times you've used each component (useful for cleaning up)
Spots inconsistencies in spacing, colors, and sizes that you might have missed

📊 Reports That Actually Help

Shows which components you use most/least (goodbye, forgotten components)
Extracts all the colors you're using (yes, even that random blue you used once)
Typography audit - finds all your text styles and font chaos
Complete inventory of your design assets

🤖 The Cool AI Part

Ask questions about your designs in normal English
Get suggestions for improvements (when it works, it's pretty neat)
No more manually counting components or checking consistency

Getting This Thing Running
What You Need

Node.js 18+
A Figma Personal Access Token (I'll show you how to get this)
Cursor IDE

Setup Steps

Get your Figma token:

Go to Figma Settings → Personal Access Tokens
Click "Create new token"
Give it a name like "My MCP experiment"
Copy the token (it starts with figd_ - don't lose it!)
Also copy your Figma file URL


Set up Cursor MCP:

Find your Cursor MCP settings file:

Mac: ~/.cursor-server/mcp_settings.json
Windows: %APPDATA%/Cursor/mcp_settings.json
Linux: ~/.config/cursor/mcp_settings.json

Add this (replace the paths and tokens with your actual ones):
json{
  "mcpServers": {
    "figma-mcp": {
      "command": "node",
      "args": ["/full/path/to/this/project/dist/index.js"],
      "env": {
        "FIGMA_ACCESS_TOKEN": "figd_your_actual_token_here",
        "FIGMA_PROJECT_URL": "https://www.figma.com/file/your-file-id/your-file-name"
      }
    }
  }
}

Turn on MCP in Cursor:

Open Cursor settings (Cmd/Ctrl + ,)
Find Features → Model Context Protocol
Turn on MCP Support
Restart Cursor (important!)



How to Use It
Once it's working, you can chat with Claude about your designs:
Ask Simple Questions
@figma-mcp What's in my Figma file?
Check Your Components
@figma-mcp How many different button styles do I have?
Find Inconsistencies
@figma-mcp Are my colors consistent across pages?
Get Component Stats
@figma-mcp Which components am I not using much?
Deep Dive into Specifics
@figma-mcp Show me all the cards in my design and their properties
Things I've Learned (aka Troubleshooting)
If it's not working:

Path issues: Use the full, absolute path to your built project
Token problems: Make sure your token starts with figd_ and has access to your file
Cursor restart: Seriously, restart Cursor after changing MCP settings
Build the project: Run npm run build first if you're using the source code

Common "oops" moments:

Forgetting to restart Cursor (I did this like 5 times)
Using a relative path instead of absolute path
Token doesn't have permission to access the Figma file

What I Built This With

TypeScript (because I like making my life complicated)
Figma API (surprisingly well-documented)
MCP SDK (still learning this)
A lot of trial and error

Honest Assessment
What works well:

Basic file analysis is solid
Component detection is pretty accurate
Color extraction works great
Integration with Cursor feels natural

What could be better:

Error handling could be more robust
Some complex nested components confuse it
I haven't tested it on huge files yet

What I want to add next:

Better component classification
Export capabilities
Maybe some design suggestions

If You Want to Help
This is a learning project, so if you spot issues or have ideas:

Open an issue if something breaks
PRs welcome if you want to improve it
Or just tell me what you think!


Personal note: This started as a weekend project because I was manually checking design consistency and thought "there has to be a better way." Turns out building your own MCP is actually pretty fun, and now I can ask Claude about my designs instead of clicking through every page. Not bad for a first attempt!
Made with ☕ and curiosity about what AI can do with design files.
