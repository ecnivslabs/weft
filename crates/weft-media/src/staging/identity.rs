use std::sync::Arc;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum Action {
    Fit,
    Clone(usize),
}

pub(super) fn plan(frames: &[Arc<Vec<u8>>]) -> Vec<Action> {
    let mut actions = Vec::with_capacity(frames.len());
    for (index, frame) in frames.iter().enumerate() {
        let action = if let Some(first) = (0..index)
            .find(|&first| actions[first] == Action::Fit && Arc::ptr_eq(&frames[first], frame))
        {
            Action::Clone(first)
        } else {
            Action::Fit
        };
        actions.push(action);
    }
    actions
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_identical_source_ownership_reuses_a_fit() {
        let a = Arc::new(vec![1]);
        let b = Arc::new(vec![2]);
        let frames = vec![a.clone(), a.clone(), b, a, Arc::new(vec![1])];
        assert_eq!(
            plan(&frames),
            [
                Action::Fit,
                Action::Clone(0),
                Action::Fit,
                Action::Clone(0),
                Action::Fit
            ]
        );
    }
}
