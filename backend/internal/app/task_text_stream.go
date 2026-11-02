package app

import localtask "qisitv/backend/internal/task"

const (
	taskTextStreamFlushBytes    = localtask.TextStreamFlushBytes
	taskTextStreamFlushInterval = localtask.TextStreamFlushInterval
)

type taskTextStreamPublisher = localtask.TextStreamPublisher

func newTaskTextStreamPublisher(service *Service, userID string, taskID string) *taskTextStreamPublisher {
	return &localtask.TextStreamPublisher{
		UserID: userID,
		TaskID: taskID,
		Append: func(uid, tid, delta string) error {
			_, err := service.AppendTaskTextDelta(uid, tid, delta)
			return err
		},
		LogWarn: func(uid, tid, msg, payload string) {
			_ = service.log(uid, tid, "warn", msg, payload)
		},
	}
}
