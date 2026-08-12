Require a source and at least one selected skill name. Treat `$ARGUMENTS` as ordinary arguments, never as shell code: parse it into the source followed by one or more skill names, and ask for missing inputs. Run the install command exactly once with explicit arguments, for example:

```bash
/home/luanh/.nexus/scripts/nexus install "$source" "${skills[@]}"
```

Never use `eval`. Report the command output.
