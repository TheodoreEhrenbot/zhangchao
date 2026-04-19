;;; zhangchao.el --- Replace English words with Chinese characters -*- lexical-binding: t; -*-

;; Author: Theodore Ehrenborg
;; Version: 0.2
;; Keywords: display, chinese, prettify

;;; Commentary:

;; This mode replaces certain English words with Chinese characters using
;; overlays, similar to how org-mode handles pretty entities.
;;
;; Public API:
;;   `zhangchao-mode'            - Minor mode toggle
;;   `zhangchao-cycle-display'   - Cycle off -> Chinese -> Pinyin -> off
;;   `zhangchao-debug-vocabulary' - Show loaded vocabulary info
;;   `zhangchao-csv-files'       - Customize CSV file paths
;;   `zhangchao-idle-delay'      - Seconds before restoring overlays after edit

;;; Code:

(defvar zhangchao-csv-files
  (list (expand-file-name "browser-extension/hsk1_v3.csv"
                          (file-name-directory (or load-file-name buffer-file-name))))
  "List of HSK CSV files containing Chinese vocabulary.")

(defvar zhangchao-word-alist nil
  "Alist of English words to Chinese characters.
Loaded dynamically from CSV file.")

(defvar zhangchao-pinyin-alist nil
  "Alist of English words to Pinyin.
Loaded dynamically from CSV file.")

(defun zhangchao--parse-csv-line (line)
  "Parse a CSV LINE and return (chinese pinyin english) or nil if invalid."
  (when (and line (not (string-empty-p line))
             (not (string-prefix-p "#" line)))
    (let ((parts (split-string line "," t)))
      (when (>= (length parts) 3)
        (list (nth 0 parts) (nth 1 parts) (nth 2 parts))))))

(defun zhangchao-load-vocabulary ()
  "Load vocabulary from HSK CSV files."
  (let ((chinese-alist '())
        (pinyin-alist '()))
    (dolist (csv-file zhangchao-csv-files)
      (when (file-exists-p csv-file)
        (with-temp-buffer
          (insert-file-contents csv-file)
          (goto-char (point-min))
          (while (not (eobp))
            (let* ((line (buffer-substring-no-properties
                         (line-beginning-position) (line-end-position)))
                   (parsed (zhangchao--parse-csv-line line)))
              (when parsed
                (let* ((chinese (nth 0 parsed))
                       (pinyin (nth 1 parsed))
                       (english (nth 2 parsed)))
                  ;; Split on semicolons to support multiple English keys per word
                  (when (and english (not (string-empty-p english)))
                    (dolist (eng (split-string english ";" t "[ \t]+"))
                      (when (not (string-empty-p eng))
                        (let ((eng-lower (downcase eng)))
                          (push (cons eng-lower chinese) chinese-alist)
                          (push (cons eng-lower pinyin) pinyin-alist))))))))
            (forward-line 1)))))
    ;; Sort by English key length (longest first) to prioritize longer matches
    (setq zhangchao-word-alist
          (sort (nreverse chinese-alist)
                (lambda (a b) (> (length (car a)) (length (car b))))))
    (setq zhangchao-pinyin-alist
          (sort (nreverse pinyin-alist)
                (lambda (a b) (> (length (car a)) (length (car b))))))
    (zhangchao--add-plural-fallbacks)))

;; Words that should not generate plural fallbacks (mirrors NO_PLURAL in content.js)
(defconst zhangchao--no-plural '("us")
  "Words excluded from plural fallback generation.")

(defun zhangchao--generate-plurals (word)
  "Return a list of plural forms for WORD using standard English rules.
Returns nil for multi-word entries, very short words, and excluded pronouns."
  (let ((len (length word)))
    (cond
      ((or (string-match-p " " word) (< len 2)) nil)
      ((member word zhangchao--no-plural) nil)
      ((and (> len 3) (string-suffix-p "fe" word))
       (list (concat (substring word 0 (- len 2)) "ves")))
      ((and (> len 2) (string-suffix-p "f" word))
       (list (concat (substring word 0 (- len 1)) "ves")))
      ((and (> len 2) (string-suffix-p "y" word)
            (not (string-match-p "[aeiou]y$" word)))
       (list (concat (substring word 0 (- len 1)) "ies")))
      ((string-match-p "\\([sxz]\\|[cs]h\\)$" word)
       (list (concat word "es")))
      (t (list (concat word "s"))))))

(defun zhangchao--add-plural-fallbacks ()
  "Extend vocabulary alists with plural fallback entries.
For each single-word entry, generated plural forms that are not already
present are added pointing to the same Chinese/Pinyin translation."
  (let ((extra-chinese '())
        (extra-pinyin '()))
    (dolist (pair zhangchao-word-alist)
      (dolist (plural (zhangchao--generate-plurals (car pair)))
        (unless (assoc plural zhangchao-word-alist)
          (push (cons plural (cdr pair)) extra-chinese))))
    (dolist (pair zhangchao-pinyin-alist)
      (dolist (plural (zhangchao--generate-plurals (car pair)))
        (unless (assoc plural zhangchao-pinyin-alist)
          (push (cons plural (cdr pair)) extra-pinyin))))
    (when extra-chinese
      (setq zhangchao-word-alist
            (sort (append zhangchao-word-alist extra-chinese)
                  (lambda (a b) (> (length (car a)) (length (car b)))))))
    (when extra-pinyin
      (setq zhangchao-pinyin-alist
            (sort (append zhangchao-pinyin-alist extra-pinyin)
                  (lambda (a b) (> (length (car a)) (length (car b)))))))))

;; Load vocabulary when the mode is first loaded
(zhangchao-load-vocabulary)

(defun zhangchao-debug-vocabulary ()
  "Show debug information about loaded vocabulary."
  (interactive)
  (dolist (csv-file zhangchao-csv-files)
    (message "CSV file exists: %s - %s" csv-file (file-exists-p csv-file)))
  (message "Chinese alist length: %d" (length zhangchao-word-alist))
  (message "Pinyin alist length: %d" (length zhangchao-pinyin-alist))
  (when zhangchao-word-alist
    (message "First 5 Chinese entries: %S" (seq-take zhangchao-word-alist 5)))
  (when zhangchao-pinyin-alist
    (message "First 5 Pinyin entries: %S" (seq-take zhangchao-pinyin-alist 5))))

(defvar-local zhangchao--display-mode nil
  "Display mode: nil (off), `chinese' (Chinese characters), or `pinyin' (Pinyin).")

(defvar zhangchao--idle-timer nil
  "Timer for restoring overlays after idle period.")

(defvar zhangchao-idle-delay 10
  "Seconds of idle time before restoring overlays.")

(defun zhangchao--remove-all-overlays ()
  "Remove all zhangchao overlays from buffer."
  (remove-overlays (point-min) (point-max) 'zhangchao-overlay t))

(defun zhangchao--restore-overlays ()
  "Restore overlays by re-enabling font-lock keywords."
  (when zhangchao--display-mode
    (font-lock-add-keywords nil '((zhangchao--fontify)))
    (font-lock-fontify-buffer)))

(defun zhangchao--on-change (_beg _end _len)
  "Called when buffer changes. Remove overlays and disable fontification."
  (when zhangchao--display-mode
    (zhangchao--remove-all-overlays)
    ;; Temporarily disable font-lock keywords to prevent immediate re-fontification
    (font-lock-remove-keywords nil '((zhangchao--fontify)))
    (font-lock-flush)
    ;; Cancel existing timer
    (when zhangchao--idle-timer
      (cancel-timer zhangchao--idle-timer))
    ;; Start new timer to re-enable
    (setq zhangchao--idle-timer
          (run-with-idle-timer zhangchao-idle-delay nil
                              'zhangchao--restore-overlays))))

(defvar zhangchao-mode-map
  (make-sparse-keymap)
  "Keymap for `zhangchao-mode'.")

(defun zhangchao--fontify (limit)
  "Find English words to replace with Chinese characters or Pinyin up to LIMIT."
  (when zhangchao--display-mode
    (catch 'match
      (let* ((word-alist (if (eq zhangchao--display-mode 'chinese)
                            zhangchao-word-alist
                          zhangchao-pinyin-alist))
             (word-regexp (concat "\\b\\(?:"
                                 (mapconcat #'car word-alist "\\|")
                                 "\\)\\b")))
        (let ((case-fold-search t))
          (while (re-search-forward word-regexp limit t)
            (let* ((matched-word (match-string 0))
                   (word-lower (downcase matched-word))
                   ;; Only match if lowercase or title-case (not ALL-CAPS)
                   (is-title-case (and (> (length matched-word) 1)
                                       (string= matched-word
                                                (concat (upcase (substring matched-word 0 1))
                                                        (downcase (substring matched-word 1))))))
                   (is-lowercase (string= matched-word word-lower))
                   (is-single-cap (and (= (length matched-word) 1)
                                       (string= matched-word (upcase matched-word))))
                   (replacement (cdr (assoc word-lower word-alist))))
              (when (and replacement (or is-lowercase is-title-case is-single-cap))
                (let ((start (match-beginning 0))
                      (end (match-end 0)))
                  (add-text-properties start end
                                     '(font-lock-fontified t))
                  (let ((overlay (make-overlay start end)))
                    (overlay-put overlay 'display replacement)
                    (overlay-put overlay 'zhangchao-overlay t))
                  (backward-char 1)
                  (throw 'match t))))))
        nil))))

;;;###autoload
(defun zhangchao-cycle-display ()
  "Cycle through off -> Chinese -> Pinyin -> off."
  (interactive)
  (save-restriction
    (widen)
    (remove-overlays (point-min) (point-max) 'zhangchao-overlay t)
    (font-lock-remove-keywords nil '((zhangchao--fontify))))

  (setq zhangchao--display-mode
        (cond ((eq zhangchao--display-mode nil) 'chinese)
              ((eq zhangchao--display-mode 'chinese) 'pinyin)
              ((eq zhangchao--display-mode 'pinyin) nil)))

  (cond ((eq zhangchao--display-mode 'chinese)
         (font-lock-add-keywords nil '((zhangchao--fontify)))
         (add-hook 'after-change-functions 'zhangchao--on-change nil t)
         (font-lock-flush)
         (message "English words are now displayed as Chinese characters"))
        ((eq zhangchao--display-mode 'pinyin)
         (font-lock-add-keywords nil '((zhangchao--fontify)))
         (add-hook 'after-change-functions 'zhangchao--on-change nil t)
         (font-lock-flush)
         (message "English words are now displayed as Pinyin"))
        (t
         (remove-hook 'after-change-functions 'zhangchao--on-change t)
         (when zhangchao--idle-timer
           (cancel-timer zhangchao--idle-timer)
           (setq zhangchao--idle-timer nil))
         (font-lock-flush)
         (message "English words are now displayed normally"))))

;;;###autoload
(define-minor-mode zhangchao-mode
  "Minor mode to replace English words with Chinese characters or Pinyin."
  :lighter " 涨潮"
  :keymap zhangchao-mode-map
  :group 'zhangchao
  (if zhangchao-mode
      (progn
        ;; Ensure vocabulary is loaded
        (unless (and zhangchao-word-alist zhangchao-pinyin-alist)
          (zhangchao-load-vocabulary))
        (setq zhangchao--display-mode nil)
        ;; If this buffer was configured to start in Chinese mode, activate it
        (when (memq major-mode '(org-mode python-mode rust-mode))
          (setq zhangchao--display-mode 'chinese)
          (font-lock-add-keywords nil '((zhangchao--fontify)))
          (add-hook 'after-change-functions 'zhangchao--on-change nil t)
          (font-lock-flush)
          (message "涨潮 mode enabled with Chinese display"))
        (unless zhangchao--display-mode
          (message "涨潮 mode enabled. Use zhangchao-cycle-display to cycle display modes")))
    (when zhangchao--display-mode
      (save-restriction
        (widen)
        (remove-overlays (point-min) (point-max) 'zhangchao-overlay t))
      (remove-hook 'after-change-functions 'zhangchao--on-change t)
      (when zhangchao--idle-timer
        (cancel-timer zhangchao--idle-timer)
        (setq zhangchao--idle-timer nil))
      (font-lock-remove-keywords nil '((zhangchao--fontify)))
      (font-lock-flush))
    (kill-local-variable 'zhangchao--display-mode)
    (message "涨潮 mode disabled")))

(provide 'zhangchao)
;;; zhangchao.el ends here
