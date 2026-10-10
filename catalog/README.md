# catalog

Curated service definitions. Each service is a folder:

```
catalog/<service-id>/
├── compose.yml   Docker Compose template with placeholders
└── meta.json     display info + user-configurable fields with validation rules
```

`meta.json` is validated against the Zod schema in `@homelab/shared` when the server loads the catalog; a malformed entry fails loudly at startup. Keep templating to simple placeholder substitution — no conditionals or loops.
