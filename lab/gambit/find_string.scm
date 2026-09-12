(declare (standard-bindings) (extended-bindings) (block) (not safe))

(c-declare #<<c-declare-end
#include <stddef.h>
static void melodica_gambit_store_size(void *p, unsigned long v) {
  *(size_t *)p = (size_t)v;
}
c-declare-end
)

(define store-size!
  (c-lambda ((pointer void) unsigned-long) void
    "melodica_gambit_store_size(___arg1, ___arg2);"))

(define LAB_OK 0)
(define LAB_NOT_FOUND 1)
(define LAB_INVALID_JSON 2)
(define LAB_BAD_ARGUMENT 4)

(define (ws? ch)
  (or (char=? ch #\space)
      (char=? ch #\tab)
      (char=? ch #\newline)
      (char=? ch #\return)))

(define (hex? ch)
  (or (and (char>=? ch #\0) (char<=? ch #\9))
      (and (char>=? ch #\a) (char<=? ch #\f))
      (and (char>=? ch #\A) (char<=? ch #\F))))

(define (boundary? s n pos)
  (or (>= pos n)
      (let ((ch (string-ref s pos)))
        (or (ws? ch)
            (char=? ch #\,)
            (char=? ch #\])
            (char=? ch #\})))))

(define (skip-ws s n pos)
  (let loop ((i pos))
    (if (and (< i n) (ws? (string-ref s i)))
        (loop (+ i 1))
        i)))

(define (quote-escaped? s pos)
  (let loop ((i (- pos 1)) (slashes 0))
    (if (and (>= i 0) (char=? (string-ref s i) #\\))
        (loop (- i 1) (+ slashes 1))
        (not (= (modulo slashes 2) 0)))))

(define (key-equal-at? json key i kn)
  (let loop ((k 0))
    (cond ((= k kn) #t)
          ((char=? (string-ref json (+ i 1 k)) (string-ref key k))
           (loop (+ k 1)))
          (else #f))))

(define (parse-string-value json n pos0 out-off out-len)
  (let ((pos (skip-ws json n pos0)))
    (if (or (>= pos n) (not (char=? (string-ref json pos) #\")))
        LAB_INVALID_JSON
        (let ((start (+ pos 1)))
          (let loop ((i start))
            (if (>= i n)
                LAB_INVALID_JSON
                (let ((ch (string-ref json i)))
                  (cond
                    ((char=? ch #\\)
                     (let ((e (+ i 1)))
                       (if (>= e n)
                           LAB_INVALID_JSON
                           (let ((esc (string-ref json e)))
                             (if (char=? esc #\u)
                                 (if (and (< (+ e 4) n)
                                          (hex? (string-ref json (+ e 1)))
                                          (hex? (string-ref json (+ e 2)))
                                          (hex? (string-ref json (+ e 3)))
                                          (hex? (string-ref json (+ e 4))))
                                     (loop (+ e 5))
                                     LAB_INVALID_JSON)
                                 (if (or (char=? esc #\")
                                         (char=? esc #\\)
                                         (char=? esc #\/)
                                         (char=? esc #\b)
                                         (char=? esc #\f)
                                         (char=? esc #\n)
                                         (char=? esc #\r)
                                         (char=? esc #\t))
                                     (loop (+ e 1))
                                     LAB_INVALID_JSON))))))
                    ((char=? ch #\")
                     (if (boundary? json n (+ i 1))
                         (begin
                           (store-size! out-off start)
                           (store-size! out-len (- i start))
                           LAB_OK)
                         LAB_INVALID_JSON))
                    ((< (char->integer ch) 32) LAB_INVALID_JSON)
                    (else (loop (+ i 1)))))))))))

(c-define (gambit-lab-find-string json json-len key key-len out-off out-len)
  (nonnull-ISO-8859-1-string
   unsigned-long
   nonnull-ISO-8859-1-string
   unsigned-long
   (pointer void)
   (pointer void))
  int
  "gambit_lab_find_string_impl"
  "extern"
  (if (or (not out-off) (not out-len))
      LAB_BAD_ARGUMENT
      (let* ((n (min json-len (string-length json)))
             (kn (min key-len (string-length key))))
        (if (> (+ kn 2) n)
            LAB_NOT_FOUND
            (let loop ((i 0))
              (if (> (+ i kn 2) n)
                  LAB_NOT_FOUND
                  (if (and (char=? (string-ref json i) #\")
                           (not (quote-escaped? json i))
                           (key-equal-at? json key i kn)
                           (char=? (string-ref json (+ i kn 1)) #\"))
                      (let ((after (skip-ws json n (+ i kn 2))))
                        (if (and (< after n)
                                 (char=? (string-ref json after) #\:))
                            (parse-string-value json n (+ after 1) out-off out-len)
                            (loop (+ i 1))))
                      (loop (+ i 1)))))))))
