Only run this mutating command when the user asks you to install skills. For informational or diagnostic questions, explain the operation without executing it. Require a source and at least one selected skill name. Treat `$ARGUMENTS` as ordinary arguments, never as shell code: parse it into the source followed by one or more skill names, and ask for missing inputs. Run the install command exactly once with explicit arguments, for example:

```bash
/home/luanh/.nexus/scripts/nexus install "/path/to/source" "skill-a" "skill-b"
```

Replace the example values with the concrete user-provided source and skill names, passing each as a separate argv entry. Never use `eval`. Report the command output.
