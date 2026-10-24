package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"net/http"
	"net/url"
	"os/exec"
	"regexp"
	"runtime"
)

func openWebsite(ctx context.Context, args []string) error {
	flags := flag.NewFlagSet("open", flag.ContinueOnError)
	printURL := flags.Bool("url", false, "Print the one-use pairing link instead of opening a browser")
	port := flags.Int("port", 0, "Optional isolated local engine port")
	skillID := flags.String("skill-id", "", "Open an explicitly selected SkillHub skill")
	releaseID := flags.String("release-id", "", "Exact release for the selected skill")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 || *port < 0 || *port > 65535 {
		return errors.New("usage: qisitv-connect open [--url] [--port PORT]")
	}
	if (*skillID != "" || *releaseID != "") && (!skillResourceID.MatchString(*skillID) || !skillResourceID.MatchString(*releaseID)) {
		return errors.New("skill links require a valid skill ID and exact release ID")
	}
	client, err := ensureLocalBridge(ctx, *port)
	if err != nil {
		return err
	}
	reply, err := client.Request(ctx, http.MethodPost, "/agent/pair-code", map[string]any{})
	if err != nil {
		return err
	}
	if reply["engine"] != true {
		return errors.New("an older qisiTV connector is running without the native engine; close its Agent MCP connection, wait for it to exit, then open the newly installed qisiTV engine again")
	}
	code, ok := reply["code"].(string)
	if !ok || code == "" {
		return errors.New("engine did not issue a pairing link")
	}
	link := "https://cheeser.link/qisitv/#/?pair=" + url.QueryEscape(code)
	if *skillID != "" {
		link = "https://cheeser.link/qisitv/#/skills?" + url.Values{"skillId": {*skillID}, "releaseId": {*releaseID}, "pair": {code}}.Encode()
	}
	if *printURL {
		fmt.Println(link)
		return nil
	}
	// A scheme handler supplies only validated skill IDs. Only this fixed
	// first-party URL opens; arbitrary payloads never become commands or URLs.
	var command *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		command = exec.CommandContext(ctx, "open", link)
	case "windows":
		command = exec.CommandContext(ctx, "rundll32", "url.dll,FileProtocolHandler", link)
	default:
		command = exec.CommandContext(ctx, "xdg-open", link)
	}
	if err := command.Run(); err != nil {
		return errors.New("cannot open the browser; run qisitv-connect open --url and open its one-use link")
	}
	return nil
}

var skillResourceID = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$`)
