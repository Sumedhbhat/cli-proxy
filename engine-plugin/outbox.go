package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

const (
	// maxSegmentBytes bounds one segment; the console deletes ingested ones.
	maxSegmentBytes = 8 << 20
	// maxPending bounds records held in memory while the disk refuses writes.
	maxPending = 4096
	// maxReportedIDs bounds the execution IDs listed in a loss marker.
	maxReportedIDs = 200
)

// Outbox appends sanitized events to JSON-lines segments. It is the sole
// writer of its directory; the console only reads and deletes finished files.
// Every line is fsynced before Append returns, so an acknowledged record
// survives an engine or machine crash.
type Outbox struct {
	mu        sync.Mutex
	dir       string
	writer    string
	startedAt time.Time
	now       func() time.Time

	file    *os.File
	size    int64
	day     string
	segment int

	pending      []Event
	failedWrites int
	dropped      int
	droppedIDs   []string
	undecodable  int
	lastError    string
	written      int64
}

// OpenOutbox creates the directory and the writer's first segment.
func OpenOutbox(dir string, now func() time.Time) (*Outbox, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	id := make([]byte, 8)
	if _, err := rand.Read(id); err != nil {
		return nil, err
	}
	o := &Outbox{dir: dir, writer: hex.EncodeToString(id), startedAt: now().UTC(), now: now}
	o.mu.Lock()
	defer o.mu.Unlock()
	if err := o.open(); err != nil {
		return nil, err
	}
	return o, nil
}

type marker struct {
	Version       int    `json:"v"`
	Type          string `json:"type"`
	At            string `json:"at"`
	Writer        string `json:"writer"`
	WriterStarted string `json:"writer_started_at"`
	Segment       int    `json:"segment"`
	PluginVersion string `json:"plugin_version,omitempty"`
	// Final marks the end written by a clean shutdown, not by rotation.
	Final        bool     `json:"final,omitempty"`
	Records      int64    `json:"records,omitempty"`
	FailedWrites int      `json:"failed_writes,omitempty"`
	Dropped      int      `json:"dropped,omitempty"`
	DroppedIDs   []string `json:"dropped_ids,omitempty"`
	Undecodable  int      `json:"undecodable,omitempty"`
	Pending      int      `json:"pending,omitempty"`
	PendingIDs   []string `json:"pending_ids,omitempty"`
	LastError    string   `json:"last_error,omitempty"`
}

func (o *Outbox) marker(kind string) marker {
	return marker{
		Version: 1, Type: kind, At: o.now().UTC().Format(time.RFC3339Nano),
		Writer: o.writer, WriterStarted: o.startedAt.Format(time.RFC3339Nano),
		Segment: o.segment, PluginVersion: pluginVersion,
	}
}

func (o *Outbox) open() error {
	o.segment++
	now := o.now().UTC()
	name := fmt.Sprintf("%s-%s-%04d.jsonl", now.Format("20060102T150405Z"), o.writer, o.segment)
	file, err := os.OpenFile(filepath.Join(o.dir, name), os.O_CREATE|os.O_EXCL|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return err
	}
	o.file, o.size, o.day = file, 0, now.Format("20060102")
	if err := o.writeLine(o.marker("segment-start")); err != nil {
		o.discardFile()
		return err
	}
	// Persist the directory entry so a crash cannot lose the new segment.
	if dir, err := os.Open(o.dir); err == nil {
		_ = dir.Sync()
		_ = dir.Close()
	}
	return nil
}

func (o *Outbox) writeLine(value any) error {
	line, err := json.Marshal(value)
	if err != nil {
		return err
	}
	line = append(line, '\n')
	written, err := o.file.Write(line)
	o.size += int64(written)
	if err != nil {
		return err
	}
	return o.file.Sync()
}

func (o *Outbox) discardFile() {
	if o.file != nil {
		_ = o.file.Close()
		o.file = nil
	}
}

func (o *Outbox) noteFailure(err error) {
	o.failedWrites++
	o.lastError = err.Error()
	o.discardFile()
}

// Append queues one event and writes everything pending. A failed write keeps
// events in memory for the next attempt; overflow is counted, never hidden.
func (o *Outbox) Append(event Event) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if len(o.pending) >= maxPending {
		o.dropped++
		if len(o.droppedIDs) < maxReportedIDs {
			o.droppedIDs = append(o.droppedIDs, event.ExecutionID)
		}
	} else {
		o.pending = append(o.pending, event)
	}
	o.flush()
}

// CountUndecodable records an engine message that could not be parsed.
func (o *Outbox) CountUndecodable() {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.undecodable++
	o.flush()
}

func (o *Outbox) flush() {
	if o.file != nil && (o.size >= maxSegmentBytes || o.now().UTC().Format("20060102") != o.day) {
		end := o.marker("segment-end")
		end.Records = o.written
		_ = o.writeLine(end)
		o.discardFile()
		o.written = 0
	}
	if o.file == nil {
		if err := o.open(); err != nil {
			o.noteFailure(err)
			return
		}
	}
	if o.failedWrites > 0 || o.dropped > 0 || o.undecodable > 0 {
		report := o.marker("write-failures")
		report.FailedWrites, report.Dropped, report.DroppedIDs = o.failedWrites, o.dropped, o.droppedIDs
		report.Undecodable, report.LastError = o.undecodable, o.lastError
		if err := o.writeLine(report); err != nil {
			o.noteFailure(err)
			return
		}
		o.failedWrites, o.dropped, o.droppedIDs, o.undecodable, o.lastError = 0, 0, nil, 0, ""
	}
	for len(o.pending) > 0 {
		if err := o.writeLine(o.pending[0]); err != nil {
			o.noteFailure(err)
			return
		}
		o.pending[0] = Event{}
		o.pending = o.pending[1:]
		o.written++
	}
}

// Close writes pending events and a segment-end marker. Events that still
// cannot be written are listed in the marker when the disk allows it.
func (o *Outbox) Close() {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.flush()
	if o.file == nil {
		if err := o.open(); err != nil {
			return
		}
	}
	end := o.marker("segment-end")
	end.Final = true
	end.Records = o.written
	end.Pending = len(o.pending)
	for i, event := range o.pending {
		if i == maxReportedIDs {
			break
		}
		end.PendingIDs = append(end.PendingIDs, event.ExecutionID)
	}
	_ = o.writeLine(end)
	o.discardFile()
}
