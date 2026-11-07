// Package writechange defines the one receipt shape for canvas nodes that a
// write changed as a side effect, rather than as the operation's explicit target.
package writechange

import "slices"

// Node lists the fields of one side-effect-changed canvas node.
// Empty Fields entries are never produced; callers omit the receipt field when
// no node has any changed field.
type Node struct {
	NodeID string   `json:"nodeId"`
	Title  string   `json:"title,omitempty"`
	Fields []string `json:"fields"`
}

// Add merges fields into the entry for nodeID, preserving first-seen order.
// It is the only place that decides the receipt shape, so every operation that
// reports side effects stays consistent.
func Add(nodes []Node, nodeID, title string, fields ...string) []Node {
	if nodeID == "" {
		return nodes
	}
	changed := make([]string, 0, len(fields))
	for _, field := range fields {
		if field != "" && !slices.Contains(changed, field) {
			changed = append(changed, field)
		}
	}
	if len(changed) == 0 {
		return nodes
	}
	for index := range nodes {
		if nodes[index].NodeID != nodeID {
			continue
		}
		if nodes[index].Title == "" && title != "" {
			nodes[index].Title = title
		}
		for _, field := range changed {
			if !slices.Contains(nodes[index].Fields, field) {
				nodes[index].Fields = append(nodes[index].Fields, field)
			}
		}
		return nodes
	}
	return append(nodes, Node{NodeID: nodeID, Title: title, Fields: changed})
}
