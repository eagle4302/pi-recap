# Changelog

## 0.1.0

- Initial release: a Grok-style recap block at the end of every exchange.
- Automatic recap on `agent_settled`, stored as a custom entry (never in LLM context).
- `/recap`, `/recap on|off`, `/recap model [auto|<provider>/<model>]`, `/recap status`.
- Model defaults to `auto`: the cheapest configured model that fits the prompt.
