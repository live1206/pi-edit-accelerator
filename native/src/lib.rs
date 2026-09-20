use memchr::{memchr_iter, memmem};
use napi::bindgen_prelude::Buffer;
use napi_derive::napi;

#[napi(object)]
pub struct NativeEdit {
    pub old_text: String,
    pub new_text: String,
}

#[napi(object)]
pub struct NativeReplacement {
    pub byte_offset: u32,
    pub old_byte_length: u32,
    pub new_text: String,
    pub first_line: u32,
    pub last_line: u32,
}

#[napi(object)]
pub struct NativePositionalWrite {
    pub position: u32,
    pub bytes: Buffer,
}

#[napi(object)]
pub struct NativeSuffixWrite {
    pub position: u32,
    pub replacement_index: u32,
}

#[napi(object)]
pub struct NativeDiffWindow {
    pub old_start_line: u32,
    pub old_bytes: Buffer,
    pub new_bytes: Buffer,
    pub has_earlier_content: bool,
    pub has_later_content: bool,
}

#[napi(object)]
pub struct NativePlan {
    pub old_line_count: u32,
    pub old_ends_with_newline: bool,
    pub replacements: Vec<NativeReplacement>,
    pub positional_writes: Option<Vec<NativePositionalWrite>>,
    pub suffix_write: Option<NativeSuffixWrite>,
    pub diff_windows: Option<Vec<NativeDiffWindow>>,
}

struct Match {
    index: usize,
    old: Vec<u8>,
    new: Vec<u8>,
    first_line: usize,
    last_line: usize,
}

fn is_ascii_whitespace_except_lf(byte: u8) -> bool {
    matches!(byte, b'\t' | 0x0b | 0x0c | b'\r' | b' ')
}

fn planned_edits_produce_change(content: &[u8], matches: &[Match]) -> bool {
    let mut source_offset = 0;
    let mut output_offset = 0;
    for matched in matches {
        let unchanged_length = matched.index - source_offset;
        if source_offset != output_offset
            && content.get(source_offset..source_offset + unchanged_length)
                != content.get(output_offset..output_offset + unchanged_length)
        {
            return true;
        }
        output_offset += unchanged_length;
        if content.get(output_offset..output_offset + matched.new.len())
            != Some(matched.new.as_slice())
        {
            return true;
        }
        output_offset += matched.new.len();
        source_offset = matched.index + matched.old.len();
    }
    let unchanged_length = content.len() - source_offset;
    if source_offset != output_offset
        && content.get(source_offset..source_offset + unchanged_length)
            != content.get(output_offset..output_offset + unchanged_length)
    {
        return true;
    }
    output_offset + unchanged_length != content.len()
}

fn as_u32(value: usize) -> Option<u32> {
    u32::try_from(value).ok()
}

fn build_diff_windows(
    content: &[u8],
    matches: &[Match],
    line_starts: &[usize],
) -> Option<Vec<NativeDiffWindow>> {
    if matches
        .iter()
        .any(|matched| matched.old.contains(&b'\n') || matched.new.contains(&b'\n'))
    {
        return None;
    }
    let mut groups: Vec<(usize, usize)> = Vec::new();
    for index in 0..matches.len() {
        if let Some((_, end)) = groups.last_mut()
            && matches[index]
                .first_line
                .saturating_sub(matches[*end].last_line)
                <= 9
        {
            *end = index;
            continue;
        }
        groups.push((index, index));
    }

    groups
        .into_iter()
        .map(|(first, last)| {
            let first_line = matches[first].first_line;
            let last_line = matches[last].last_line;
            let segment_start_line = first_line.saturating_sub(4);
            let segment_last_line = (last_line + 4).min(line_starts.len() - 1);
            let segment_start = line_starts[segment_start_line];
            let segment_end = line_starts
                .get(segment_last_line + 1)
                .copied()
                .unwrap_or(content.len());
            let old_bytes = content[segment_start..segment_end].to_vec();
            let mut new_bytes = old_bytes.clone();
            for matched in matches[first..=last].iter().rev() {
                let local_start = matched.index - segment_start;
                new_bytes.splice(
                    local_start..local_start + matched.old.len(),
                    matched.new.iter().copied(),
                );
            }
            Some(NativeDiffWindow {
                old_start_line: as_u32(segment_start_line)?,
                old_bytes: old_bytes.into(),
                new_bytes: new_bytes.into(),
                has_earlier_content: segment_start > 0,
                has_later_content: segment_end < content.len(),
            })
        })
        .collect()
}

#[napi]
pub fn plan_ascii_edits(content: Buffer, edits: Vec<NativeEdit>) -> Option<NativePlan> {
    let content = content.as_ref();
    if content.is_empty() || !content.is_ascii() || content.contains(&b'\r') || edits.is_empty() {
        return None;
    }

    let mut matches = Vec::with_capacity(edits.len());
    for edit in edits {
        if edit.old_text.is_empty() || !edit.old_text.is_ascii() || !edit.new_text.is_ascii() {
            return None;
        }
        let old = edit.old_text.into_bytes();
        let new = edit.new_text.into_bytes();
        let index = memmem::find(content, &old)?;
        if memmem::find(&content[index + 1..], &old).is_some() {
            return None;
        }
        matches.push(Match {
            index,
            old,
            new,
            first_line: 0,
            last_line: 0,
        });
    }

    matches.sort_unstable_by_key(|matched| matched.index);
    for pair in matches.windows(2) {
        if pair[0].index + pair[0].old.len() > pair[1].index {
            return None;
        }
    }
    if !planned_edits_produce_change(content, &matches) {
        return None;
    }

    let mut current_line = 0usize;
    let mut match_index = 0usize;
    let mut line_starts = vec![0usize];
    for newline in memchr_iter(b'\n', content) {
        while match_index < matches.len() && matches[match_index].index <= newline {
            let matched = &mut matches[match_index];
            matched.first_line = current_line;
            let final_index = matched.index + matched.old.len() - 1;
            matched.last_line =
                current_line + memchr_iter(b'\n', &content[matched.index..=final_index]).count();
            match_index += 1;
        }
        if newline > 0 && is_ascii_whitespace_except_lf(content[newline - 1]) {
            return None;
        }
        current_line += 1;
        line_starts.push(newline + 1);
    }
    while match_index < matches.len() {
        let matched = &mut matches[match_index];
        matched.first_line = current_line;
        let final_index = matched.index + matched.old.len() - 1;
        matched.last_line =
            current_line + memchr_iter(b'\n', &content[matched.index..=final_index]).count();
        match_index += 1;
    }
    if !content.ends_with(b"\n")
        && content
            .last()
            .is_some_and(|byte| is_ascii_whitespace_except_lf(*byte))
    {
        return None;
    }

    let diff_windows = build_diff_windows(content, &matches, &line_starts);
    let mut equal_lengths = true;
    let mut positional_writes = Vec::new();
    let mut first_changed = None;
    for (index, matched) in matches.iter().enumerate() {
        if matched.old != matched.new {
            first_changed.get_or_insert((matched.index, index));
            if matched.old.len() == matched.new.len() {
                positional_writes.push(NativePositionalWrite {
                    position: as_u32(matched.index)?,
                    bytes: matched.new.clone().into(),
                });
            } else {
                equal_lengths = false;
            }
        }
    }

    let suffix_write = if equal_lengths {
        None
    } else {
        let (position, replacement_index) = first_changed?;
        Some(NativeSuffixWrite {
            position: as_u32(position)?,
            replacement_index: as_u32(replacement_index)?,
        })
    };
    let replacements = matches
        .into_iter()
        .map(|matched| {
            Some(NativeReplacement {
                byte_offset: as_u32(matched.index)?,
                old_byte_length: as_u32(matched.old.len())?,
                new_text: String::from_utf8(matched.new).ok()?,
                first_line: as_u32(matched.first_line)?,
                last_line: as_u32(matched.last_line)?,
            })
        })
        .collect::<Option<Vec<_>>>()?;

    Some(NativePlan {
        old_line_count: as_u32(current_line + 1)?,
        old_ends_with_newline: content.ends_with(b"\n"),
        replacements,
        positional_writes: equal_lengths.then_some(positional_writes),
        suffix_write,
        diff_windows,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn edit(old_text: &str, new_text: &str) -> NativeEdit {
        NativeEdit {
            old_text: old_text.to_owned(),
            new_text: new_text.to_owned(),
        }
    }

    #[test]
    fn plans_distant_ascii_edits() {
        let plan = plan_ascii_edits(
            Buffer::from(b"first\nmiddle\nlast\n".to_vec()),
            vec![edit("first", "FIRST"), edit("last", "LAST")],
        )
        .unwrap();
        assert_eq!(plan.old_line_count, 4);
        assert_eq!(plan.replacements[0].first_line, 0);
        assert_eq!(plan.replacements[1].first_line, 2);
        assert!(plan.positional_writes.is_some());
        assert!(plan.suffix_write.is_none());
    }

    #[test]
    fn rejects_duplicates_overlaps_noops_and_trailing_whitespace() {
        assert!(plan_ascii_edits(Buffer::from(b"a a\n".to_vec()), vec![edit("a", "b")]).is_none());
        assert!(
            plan_ascii_edits(
                Buffer::from(b"abc\n".to_vec()),
                vec![edit("ab", "x"), edit("bc", "y")]
            )
            .is_none()
        );
        assert!(plan_ascii_edits(Buffer::from(b"abc\n".to_vec()), vec![edit("a", "a")]).is_none());
        assert!(plan_ascii_edits(Buffer::from(b"abc \n".to_vec()), vec![edit("a", "A")]).is_none());
    }
}
