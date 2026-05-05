use std::sync::Arc;

use kordi_session::reflection_lessons::{
    NewReflectionLesson, ReflectionScope, ReflectionSource, save_reflection_lesson,
};
use kordi_tools::{
    ReflectionLessonRequest, ReflectionLessonResponse, ReflectionRuntime, SaveReflectionLessonFn,
};
use tokio::sync::Mutex;

pub(crate) fn build_reflection_runtime(
    conn: Arc<Mutex<rusqlite::Connection>>,
) -> ReflectionRuntime {
    let save_lesson: SaveReflectionLessonFn = Arc::new(move |request: ReflectionLessonRequest| {
        let conn = conn.clone();
        Box::pin(async move {
            let scope = parse_scope(&request.scope)?;
            let source = parse_source(&request.source)?;
            let lesson_id = {
                let conn = conn.lock().await;
                save_reflection_lesson(
                    &conn,
                    NewReflectionLesson {
                        scope,
                        scope_id: request.scope_id.clone(),
                        lesson: request.lesson.clone(),
                        source,
                    },
                )
                .map_err(|err| kordi_core::error::KordiError::Tool(err.to_string()))?
            };
            Ok(ReflectionLessonResponse {
                lesson_id,
                scope: request.scope,
                scope_id: request.scope_id,
            })
        })
    });
    ReflectionRuntime { save_lesson }
}

fn parse_scope(scope: &str) -> kordi_core::error::KordiResult<ReflectionScope> {
    match scope {
        "conversation" => Ok(ReflectionScope::Conversation),
        "group" => Ok(ReflectionScope::Group),
        "project" => Ok(ReflectionScope::Project),
        other => Err(kordi_core::error::KordiError::Tool(format!(
            "unknown reflection scope `{other}`"
        ))),
    }
}

fn parse_source(source: &str) -> kordi_core::error::KordiResult<ReflectionSource> {
    match source {
        "user_correction" => Ok(ReflectionSource::UserCorrection),
        "repeated_failure" => Ok(ReflectionSource::RepeatedFailure),
        "outcome" => Ok(ReflectionSource::Outcome),
        "manual" => Ok(ReflectionSource::Manual),
        other => Err(kordi_core::error::KordiError::Tool(format!(
            "unknown reflection source `{other}`"
        ))),
    }
}
