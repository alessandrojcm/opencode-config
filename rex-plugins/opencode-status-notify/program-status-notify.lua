-- Forward OpenCode's OSC 7501 "blocked" status to a macOS notification.
-- Run with: rex do program-status-notify.lua --all

local separator = string.char(0)
local states = {}

local function clean(value, fallback)
  if type(value) ~= "string" or value == "" then value = fallback end
  if type(value) ~= "string" then return "" end

  -- OSC 7501 text is one line, but keep notification and AppleScript input safe.
  value = value:gsub("[%z\1-\31\127]", " ")
  value = value:gsub("%s+", " "):gsub("^%s+", ""):gsub("%s+$", "")
  return value
end

local function apple_string(value)
  return '"' .. value:gsub("\\", "\\\\"):gsub('"', '\\"') .. '"'
end

local function notify(record)
  local kind = record.kind
  local fallback = ({
    permission = "Permission needs input",
    question = "Input needs a response",
    auth = "Authentication is required",
  })[kind] or "OpenCode is waiting for your input"

  local body = clean(record.msg or record.message, fallback)
  if body == "" then body = fallback end

  local subtitle = clean(record.title, "OpenCode session")
  if subtitle == "" then subtitle = "OpenCode session" end

  local script = "display notification " .. apple_string(body)
    .. " with title " .. apple_string("OpenCode needs you")
    .. " subtitle " .. apple_string(subtitle)

  local ok, result, err = pcall(rex.exec, {
    "/usr/bin/osascript",
    "-e",
    script,
  }, { timeout = 10 })

  if not ok then
    print("Could not show OpenCode status notification: " .. tostring(result))
  elseif result == nil then
    print("Could not show OpenCode status notification: " .. tostring(err))
  elseif not result.ok then
    print("Could not show OpenCode status notification: " .. tostring(result.stderr))
  else
    print("Sent OpenCode waiting notification")
  end
end

local function record_key(block_id, id)
  return tostring(block_id or "") .. separator .. tostring(id or "")
end

local function clear_block_state(block_id)
  local prefix = tostring(block_id or "") .. separator
  for key in pairs(states) do
    if key:sub(1, #prefix) == prefix then states[key] = nil end
  end
end

rex.on("terminal.program_status_changed", function(ctx, ev)
  local record = ev.record
  if type(record) ~= "table" then return end

  local id = ev.id or record.id
  local key = record_key(ctx.block_id or ev.block_id, id)
  local was_blocked = states[key] == "blocked"
  states[key] = record.state

  if record.state ~= "blocked" or was_blocked then return end

  -- OpenCode reports each waiting session as a child record and mirrors a summary
  -- at the root. Ignore the root (no id) to avoid duplicate notifications.
  if type(id) ~= "string" or id == "" then return end

  -- Limit this watcher to OpenCode rather than every OSC 7501-capable program.
  if record.app ~= "opencode" and record.effective_app ~= "opencode" then return end

  notify(record)
end)

rex.on("terminal.program_status_removed", function(ctx, ev)
  local prefix = tostring(ctx.block_id or ev.block_id or "") .. separator
  local ids = ev.ids or {}
  if #ids == 0 then
    clear_block_state(ctx.block_id or ev.block_id)
    return
  end

  for _, id in ipairs(ids) do
    states[prefix .. tostring(id)] = nil
  end
end)

rex.on("block_closed", function(ctx, ev)
  clear_block_state(ev.block_id)
end)
