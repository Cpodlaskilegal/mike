-- Persist the explicit document set selected for each tabular review.
--
-- Existing reviews can still derive membership from tabular_cells; new and
-- updated reviews store document_ids as the source of truth so removing all
-- rows from a review does not cause project-wide document expansion.

ALTER TABLE public.tabular_reviews
  ADD COLUMN IF NOT EXISTS document_ids jsonb;
